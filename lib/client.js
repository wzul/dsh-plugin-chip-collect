/**
 * The CHIP Collect HTTP client.
 *
 * Deliberately thin and dependency-free: build the URL, attach the bearer token,
 * parse the JSON, and translate failures into {@link ChipCollectError}. Retry
 * policy, idempotency keys, and the vendor's error envelope all live here so the
 * tool layer only ever deals with either a parsed response body or one error type.
 *
 * @module dsh-plugin-chip-collect/client
 */
import { randomUUID } from "node:crypto";
import { ChipCollectError } from "./errors.js";
import { PLUGIN_NAME, PLUGIN_VERSION } from "./version.js";

/** The only server the CHIP Collect OpenAPI document declares. */
export const DEFAULT_BASE_URL = "https://gate.chip-in.asia/api/v1";

/** Methods that change server state, and therefore carry an idempotency key. */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** First backoff step for a retried request. */
const RETRY_BASE_DELAY_MS = 300;

/** Ceiling for a computed backoff step, before `Retry-After` is considered. */
const RETRY_MAX_DELAY_MS = 8_000;

/** Hosts allowed to answer over plain HTTP, so tests can point at a local server. */
const INSECURE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Validate and normalize the API base URL.
 *
 * A trailing slash is stripped so path concatenation stays predictable, and plain
 * HTTP is refused for anything that is not a loopback host — the bearer token
 * travels on every request.
 *
 * @param value - Candidate base URL.
 * @returns The normalized base URL.
 * @throws {ChipCollectError} When the URL is missing, malformed, or insecure.
 */
export function normalizeBaseUrl(value) {
  const trimmed = String(value ?? "").trim().replace(/\/+$/u, "");
  if (trimmed.length === 0) {
    throw new ChipCollectError(`chip-collect: "baseUrl" must be a URL such as ${DEFAULT_BASE_URL}`, { code: "INVALID_BASE_URL" });
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch (cause) {
    throw new ChipCollectError(`chip-collect: "baseUrl" is not a valid URL: ${trimmed}`, { code: "INVALID_BASE_URL", cause });
  }
  if (url.protocol !== "https:" && !INSECURE_HOSTS.has(url.hostname)) {
    throw new ChipCollectError(
      `chip-collect: refusing to send a bearer token over ${url.protocol}// to ${url.hostname}; use https except on loopback`,
      { code: "INSECURE_BASE_URL" },
    );
  }
  return trimmed;
}

/**
 * Validate the secret key shape before it is put on the wire.
 *
 * @param value - Resolved secret key.
 * @returns The trimmed key.
 * @throws {ChipCollectError} When the key is empty or contains header-breaking characters.
 */
export function assertSecretKey(value) {
  const key = String(value ?? "").trim();
  if (key.length === 0) throw new ChipCollectError("chip-collect: the resolved CHIP Collect secret key is empty", { code: "MISSING_SECRET_KEY" });
  if (/[\s\u0000-\u001f\u007f]/u.test(key)) {
    throw new ChipCollectError("chip-collect: the CHIP Collect secret key contains whitespace or control characters", { code: "INVALID_SECRET_KEY" });
  }
  return key;
}

/**
 * Assemble the request URL, appending query parameters.
 *
 * Array values repeat the key (`?currency=MYR&currency=USD`), which is how the
 * CHIP API expresses a multi-value filter. Empty strings and nullish values are
 * skipped so an unset optional tool argument never becomes `?foo=`.
 *
 * @param baseUrl - Normalized base URL.
 * @param path - Path beginning with `/`.
 * @param query - Optional query parameters.
 * @returns The fully qualified URL.
 */
export function buildUrl(baseUrl, path, query) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined || item === null || item === "") continue;
      url.searchParams.append(key, String(item));
    }
  }
  return url;
}

/**
 * Read a `Retry-After` header, which may be a delay in seconds or an HTTP date.
 *
 * @param value - Raw header value.
 * @returns The delay in milliseconds, or `undefined` when absent or unusable.
 */
export function parseRetryAfter(value) {
  if (value === null || value === undefined) return undefined;
  const raw = String(value).trim();
  if (raw.length === 0) return undefined;
  if (/^\d+$/u.test(raw)) return Number(raw) * 1_000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/**
 * Pull the message and code out of a CHIP error body.
 *
 * CHIP documents `{"__all__": {"message": "...", "code": "..."}}` and, for an
 * invalid recurring token, the same key holding an array of those objects. A few
 * endpoints answer with a bare `detail`/`message`, so those are read too.
 *
 * @param payload - Parsed response body, of unknown shape.
 * @returns The extracted message and code, each possibly `undefined`.
 */
export function extractChipError(payload) {
  if (payload === null || payload === undefined) return {};
  if (typeof payload === "string") return { message: payload };
  if (typeof payload !== "object") return { message: String(payload) };
  const bag = "__all__" in payload ? payload.__all__ : payload;
  const first = Array.isArray(bag) ? bag[0] : bag;
  if (first === null || first === undefined || typeof first !== "object") {
    return typeof first === "string" ? { message: first } : {};
  }
  const message = [first.message, first.detail, first.error].find((candidate) => typeof candidate === "string" && candidate.length > 0);
  const code = [first.code, first.error_code].find((candidate) => typeof candidate === "string" && candidate.length > 0);
  return {
    ...(message === undefined ? {} : { message }),
    ...(code === undefined ? {} : { code }),
  };
}

/**
 * Sleep, honoring cancellation.
 *
 * @param ms - Delay in milliseconds.
 * @param signal - Optional caller signal.
 * @returns A promise that settles when the delay elapses.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Exponential backoff with full jitter, capped.
 *
 * @param attempt - Zero-based attempt index that already failed.
 * @returns Delay in milliseconds.
 */
function backoffDelay(attempt) {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/**
 * Create a client bound to one base URL and retry policy.
 *
 * @param options - Client configuration.
 * @param options.baseUrl - API base URL; validated by {@link normalizeBaseUrl}.
 * @param options.timeoutMs - Per-attempt timeout in milliseconds.
 * @param options.maxRetries - Extra attempts after the first for retryable failures.
 * @param options.fetchImpl - Fetch implementation; defaults to the global one.
 * @returns A client whose `request` resolves to the parsed response body.
 */
export function createClient(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs ?? 30_000));
  const maxRetries = Math.max(0, Number(options.maxRetries ?? 2));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const userAgent = `${PLUGIN_NAME}/${PLUGIN_VERSION}`;

  /**
   * Perform one HTTP round trip without retrying.
   *
   * @param method - Uppercase HTTP method.
   * @param url - Fully qualified URL.
   * @param headers - Request headers.
   * @param body - Serialized body, when there is one.
   * @param signal - Combined cancellation signal.
   * @returns The status, headers, and decoded body.
   */
  async function send(method, url, headers, body, signal) {
    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal,
      redirect: "follow",
    });
    const text = await response.text();
    let data = text.length === 0 ? null : text;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        /* Non-JSON success bodies are returned as text; CHIP only does this for the PEM public key path. */
      }
    }
    return { response, data };
  }

  return {
    baseUrl,
    timeoutMs,
    maxRetries,

    /**
     * Issue one API request, retrying transient failures.
     *
     * Writes always carry an `Idempotency-Key`, generated here when the caller did
     * not supply one, so a retry after a timeout cannot double-charge. The same key
     * is reused across every attempt of a single logical call.
     *
     * @param method - HTTP method.
     * @param path - Path beginning with `/`.
     * @param requestOptions - Request inputs.
     * @param requestOptions.secretKey - Bearer token.
     * @param requestOptions.query - Query parameters.
     * @param requestOptions.body - JSON-serializable request body.
     * @param requestOptions.idempotencyKey - Caller-supplied idempotency key.
     * @param requestOptions.signal - Caller cancellation signal.
     * @returns The parsed response body, or `null` for an empty 2xx response.
     * @throws {ChipCollectError} On a non-2xx response or an exhausted transport failure.
     */
    async request(method, path, requestOptions = {}) {
      const upper = String(method).toUpperCase();
      const key = assertSecretKey(requestOptions.secretKey);
      const url = buildUrl(baseUrl, path, requestOptions.query);
      const isWrite = WRITE_METHODS.has(upper);
      const idempotencyKey = requestOptions.idempotencyKey ?? (isWrite ? randomUUID() : undefined);
      const headers = {
        accept: "application/json",
        authorization: `Bearer ${key}`,
        "user-agent": userAgent,
        ...(requestOptions.body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      };
      const payload = requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body);
      const attempts = maxRetries + 1;
      let lastError;
      let nextDelayMs;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) {
          await sleep(nextDelayMs ?? backoffDelay(attempt - 1), requestOptions.signal);
          nextDelayMs = undefined;
        }
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = requestOptions.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([requestOptions.signal, timeoutSignal]);
        let result;
        try {
          result = await send(upper, url, headers, payload, signal);
        } catch (cause) {
          if (requestOptions.signal?.aborted === true) {
            throw new ChipCollectError(`chip-collect: ${upper} ${path} was cancelled`, { code: "ABORTED", cause });
          }
          const timedOut = timeoutSignal.aborted;
          lastError = new ChipCollectError(
            timedOut
              ? `chip-collect: ${upper} ${path} timed out after ${timeoutMs} ms`
              : `chip-collect: ${upper} ${path} failed to reach ${url.host}: ${String(cause?.message ?? cause)}`,
            { code: timedOut ? "TIMEOUT" : "NETWORK_ERROR", retryable: true, cause },
          );
          if (attempt < attempts - 1) continue;
          throw lastError;
        }

        const { response, data } = result;
        if (response.ok) return data;

        const { message, code } = extractChipError(data);
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        const retryable = response.status === 429 || response.status >= 500;
        const detail = message ?? (typeof data === "string" && data.length > 0 ? data.slice(0, 500) : response.statusText);
        lastError = new ChipCollectError(
          `CHIP Collect ${upper} ${path} failed with HTTP ${response.status}`
            + `${code === undefined ? "" : ` (${code})`}: ${detail}`,
          { code: "API_ERROR", status: response.status, apiCode: code, retryable, details: data },
        );
        if (retryable && attempt < attempts - 1) {
          if (retryAfterMs !== undefined && retryAfterMs > 0) nextDelayMs = Math.min(retryAfterMs, 30_000);
          continue;
        }
        throw lastError;
      }
      /* v8 ignore next -- the loop either returns, throws, or continues with attempts remaining. */
      throw lastError ?? new ChipCollectError(`chip-collect: ${upper} ${path} failed`, { code: "API_ERROR" });
    },
  };
}
