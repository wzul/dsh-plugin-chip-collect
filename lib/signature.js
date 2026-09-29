/**
 * CHIP Collect callback signature verification.
 *
 * CHIP signs every callback delivery with an RSA PKCS#1 v1.5 signature over the
 * SHA-256 digest of the raw request body and sends it in the `X-Signature`
 * header, base64-encoded. Success callbacks (`success_callback` on a purchase) are
 * verified with the company key from `GET /public_key/`; webhook subscriptions are
 * verified with the dedicated `public_key` returned on the subscription itself.
 *
 * The raw bytes matter: verify before parsing the JSON, and never re-serialize the
 * body first, because any whitespace change invalidates the signature.
 *
 * @module dsh-plugin-chip-collect/signature
 */
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { ChipCollectError } from "./errors.js";

/**
 * Turn whatever a caller has — a bare PEM, a JSON-encoded PEM string as returned by
 * `GET /public_key/`, or a PEM whose newlines were copied through as literal `\n`
 * escapes — into a usable key object.
 *
 * @param value - Candidate public key text.
 * @returns A Node `KeyObject` for the public key.
 * @throws {ChipCollectError} When no RSA public key can be parsed.
 */
export function parsePublicKey(value) {
  const text = normalizePublicKeyText(value);
  try {
    const key = createPublicKey(text);
    if (key.asymmetricKeyType !== "rsa") {
      throw new ChipCollectError(`chip-collect: the CHIP Collect public key is ${key.asymmetricKeyType}, not RSA`, { code: "INVALID_PUBLIC_KEY" });
    }
    return key;
  } catch (cause) {
    if (cause instanceof ChipCollectError) throw cause;
    throw new ChipCollectError(
      "chip-collect: could not parse the CHIP Collect public key; expected a PEM block such as "
        + '"-----BEGIN PUBLIC KEY-----…" (GET /public_key/ returns it JSON-encoded, with surrounding quotes)',
      { code: "INVALID_PUBLIC_KEY", cause },
    );
  }
}

/**
 * Normalize the various textual forms a public key arrives in.
 *
 * @param value - Candidate public key text.
 * @returns PEM text with real newlines.
 * @throws {ChipCollectError} When the value is empty.
 */
export function normalizePublicKeyText(value) {
  let text = String(value ?? "").trim();
  if (text.length === 0) {
    throw new ChipCollectError("chip-collect: a CHIP Collect public key is required to verify a callback signature", { code: "MISSING_PUBLIC_KEY" });
  }
  // `GET /public_key/` answers with a JSON-encoded PEM string, so the body itself is
  // `"-----BEGIN PUBLIC KEY-----\n…"` and must be JSON-decoded first.
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      text = JSON.parse(text);
    } catch {
      text = text.slice(1, -1);
    }
  }
  // A PEM that travelled through a log line or a JSON string without being decoded
  // still carries two-character `\n` sequences instead of line breaks.
  if (!text.includes("\n") && text.includes("\\n")) text = text.replace(/\\n/gu, "\n");
  return text.trim();
}

/**
 * Verify one callback delivery.
 *
 * @param options - Verification inputs.
 * @param options.signature - The `X-Signature` header value, base64.
 * @param options.body - The raw request body bytes, exactly as received.
 * @param options.publicKey - PEM text or a parsed `KeyObject`.
 * @returns `true` only when the signature is valid for the body.
 * @throws {ChipCollectError} When the signature header, the body, or the key is unusable.
 */
export function verifyCallback(options) {
  const signature = String(options.signature ?? "").trim();
  if (signature.length === 0) {
    throw new ChipCollectError("chip-collect: the callback has no X-Signature header to verify", { code: "MISSING_SIGNATURE" });
  }
  const body = options.body;
  if (body === undefined || body === null) {
    throw new ChipCollectError("chip-collect: the raw callback body is required to verify a signature", { code: "MISSING_BODY" });
  }
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const key = typeof options.publicKey === "object" && options.publicKey !== null && "asymmetricKeyType" in options.publicKey
    ? options.publicKey
    : parsePublicKey(options.publicKey);
  let decoded;
  try {
    decoded = Buffer.from(signature, "base64");
  } catch (cause) {
    throw new ChipCollectError("chip-collect: X-Signature is not valid base64", { code: "INVALID_SIGNATURE", cause });
  }
  if (decoded.length === 0) {
    throw new ChipCollectError("chip-collect: X-Signature decoded to zero bytes", { code: "INVALID_SIGNATURE" });
  }
  return verifySignature("RSA-SHA256", bytes, key, decoded);
}

/**
 * Human-readable outcome for a verification attempt, so a tool result can report
 * the verdict without the model having to interpret a bare boolean.
 *
 * @param verified - Whether the signature matched.
 * @param eventType - Optional `event_type` read from the payload.
 * @returns One sentence describing the verdict.
 */
export function describeVerification(verified, eventType) {
  const subject = eventType === undefined ? "this callback" : `the "${eventType}" callback`;
  return verified
    ? `X-Signature is valid for ${subject}: the body was signed by the CHIP Collect key and was not modified in transit.`
    : `X-Signature does NOT match ${subject}: treat the delivery as untrusted and do not act on its payload. `
      + "Common causes are a re-serialized body, the wrong key (a webhook's own public_key versus the company key), "
      + "or a test/live key mismatch.";
}
