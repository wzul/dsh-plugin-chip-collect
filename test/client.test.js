/**
 * Unit tests for the HTTP client: URL building, error translation, retry policy,
 * and the idempotency guarantee that a retried write reuses one key.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  assertSecretKey,
  buildUrl,
  createClient,
  extractChipError,
  normalizeBaseUrl,
  parseRetryAfter,
} from "../lib/client.js";

/**
 * Run `subject` against a throwaway HTTP server bound to a loopback port.
 *
 * @param handler - Node request listener.
 * @param subject - Callback receiving the server's base URL.
 * @returns Whatever `subject` resolves to.
 */
async function withServer(handler, subject) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await subject(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("normalizeBaseUrl strips trailing slashes and keeps the documented default", () => {
  assert.equal(normalizeBaseUrl("https://gate.chip-in.asia/api/v1/"), "https://gate.chip-in.asia/api/v1");
  assert.equal(normalizeBaseUrl("  https://gate.chip-in.asia/api/v1///  "), "https://gate.chip-in.asia/api/v1");
});

test("normalizeBaseUrl refuses to send a bearer token over plain HTTP", () => {
  assert.throws(() => normalizeBaseUrl("http://gate.chip-in.asia/api/v1"), { code: "INSECURE_BASE_URL" });
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8080/api/v1"), "http://127.0.0.1:8080/api/v1");
  assert.equal(normalizeBaseUrl("http://localhost:8080"), "http://localhost:8080");
});

test("normalizeBaseUrl rejects an empty or malformed URL", () => {
  assert.throws(() => normalizeBaseUrl(""), { code: "INVALID_BASE_URL" });
  assert.throws(() => normalizeBaseUrl("not a url"), { code: "INVALID_BASE_URL" });
});

test("assertSecretKey rejects an empty key and header-breaking characters", () => {
  assert.equal(assertSecretKey("  sk_live_abc  "), "sk_live_abc");
  assert.throws(() => assertSecretKey("   "), { code: "MISSING_SECRET_KEY" });
  assert.throws(() => assertSecretKey("abc def"), { code: "INVALID_SECRET_KEY" });
  assert.throws(() => assertSecretKey("abc\ndef"), { code: "INVALID_SECRET_KEY" });
});

test("buildUrl repeats array values and skips empty query slots", () => {
  const url = buildUrl("https://x.test/api/v1", "/payment_methods/", {
    brand_id: "b1",
    currency: ["MYR", "USD"],
    amount: 1000,
    country: undefined,
    language: null,
    flow: "",
  });
  assert.equal(url.pathname, "/api/v1/payment_methods/");
  assert.deepEqual(url.searchParams.getAll("currency"), ["MYR", "USD"]);
  assert.equal(url.searchParams.get("brand_id"), "b1");
  assert.equal(url.searchParams.get("amount"), "1000");
  assert.equal(url.searchParams.has("country"), false);
  assert.equal(url.searchParams.has("language"), false);
  assert.equal(url.searchParams.has("flow"), false);
});

test("parseRetryAfter reads seconds, HTTP dates, and rejects noise", () => {
  assert.equal(parseRetryAfter("5"), 5_000);
  assert.equal(parseRetryAfter(" 0 "), 0);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(""), undefined);
  assert.equal(parseRetryAfter("not-a-date"), undefined);
  const inTwoSeconds = new Date(Date.now() + 2_000).toUTCString();
  const parsed = parseRetryAfter(inTwoSeconds);
  assert.ok(parsed > 500 && parsed <= 2_000, `expected roughly 2000ms, got ${parsed}`);
});

test("extractChipError reads both documented error envelopes and the bare fallbacks", () => {
  assert.deepEqual(extractChipError({ __all__: { message: "Bad amount", code: "invalid_amount" } }), {
    message: "Bad amount",
    code: "invalid_amount",
  });
  assert.deepEqual(extractChipError({ __all__: [{ message: "Token invalid", code: "recurring_token_invalid" }] }), {
    message: "Token invalid",
    code: "recurring_token_invalid",
  });
  assert.deepEqual(extractChipError({ detail: "Not found" }), { message: "Not found" });
  assert.deepEqual(extractChipError("plain text"), { message: "plain text" });
  assert.deepEqual(extractChipError({ __all__: [] }), {});
  assert.deepEqual(extractChipError(null), {});
});

test("a GET sends the bearer token, omits an idempotency key, and parses JSON", async () => {
  let seen;
  await withServer((req, res) => {
    seen = { method: req.method, url: req.url, auth: req.headers.authorization, idem: req.headers["idempotency-key"], agent: req.headers["user-agent"] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "p1", status: "paid" }));
  }, async (baseUrl) => {
    const client = createClient({ baseUrl: `${baseUrl}/api/v1`, timeoutMs: 5_000, maxRetries: 0 });
    const body = await client.request("GET", "/purchases/p1/", { secretKey: "sk_test_xyz" });
    assert.deepEqual(body, { id: "p1", status: "paid" });
  });
  assert.equal(seen.method, "GET");
  assert.equal(seen.url, "/api/v1/purchases/p1/");
  assert.equal(seen.auth, "Bearer sk_test_xyz");
  assert.equal(seen.idem, undefined);
  assert.equal(seen.agent, "dsh-plugin-chip-collect/1.0.0");
});

test("a POST always carries an idempotency key, and an explicit one is honored", async () => {
  const keys = [];
  await withServer((req, res) => {
    keys.push(req.headers["idempotency-key"]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  }, async (baseUrl) => {
    const client = createClient({ baseUrl, timeoutMs: 5_000, maxRetries: 0 });
    await client.request("POST", "/purchases/", { secretKey: "sk_test_xyz", body: { a: 1 } });
    await client.request("POST", "/purchases/", { secretKey: "sk_test_xyz", body: { a: 1 }, idempotencyKey: "fixed-key" });
  });
  assert.match(keys[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  assert.equal(keys[1], "fixed-key");
});

test("an empty 2xx body becomes null, a JSON string is decoded, and plain text survives", async () => {
  await withServer((req, res) => {
    if (req.url.endsWith("/empty/")) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url.endsWith("/public_key/")) {
      // GET /public_key/ answers with a JSON-encoded PEM string, so the client hands
      // back the decoded PEM rather than the quoted literal.
      res.writeHead(200, { "content-type": "application/json" });
      res.end('"-----BEGIN PUBLIC KEY-----"');
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pong");
  }, async (baseUrl) => {
    const client = createClient({ baseUrl, timeoutMs: 5_000, maxRetries: 0 });
    assert.equal(await client.request("GET", "/empty/", { secretKey: "k" }), null);
    assert.equal(await client.request("GET", "/public_key/", { secretKey: "k" }), "-----BEGIN PUBLIC KEY-----");
    assert.equal(await client.request("GET", "/plain/", { secretKey: "k" }), "pong");
  });
});

test("a 400 is fatal on the first attempt and carries the vendor code", async () => {
  let attempts = 0;
  await withServer((req, res) => {
    attempts += 1;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ __all__: { message: "Purchase cannot be refunded", code: "purchase_refund_error" } }));
  }, async (baseUrl) => {
    const client = createClient({ baseUrl, timeoutMs: 5_000, maxRetries: 2 });
    await assert.rejects(
      () => client.request("POST", "/purchases/p1/refund/", { secretKey: "k" }),
      (error) => {
        assert.equal(error.code, "API_ERROR");
        assert.equal(error.status, 400);
        assert.equal(error.apiCode, "purchase_refund_error");
        assert.equal(error.retryable, false);
        assert.match(error.message, /Purchase cannot be refunded/u);
        return true;
      },
    );
  });
  assert.equal(attempts, 1, "a 400 must not be retried");
});

test("a 503 is retried with the same idempotency key and then succeeds", async () => {
  const keys = [];
  let attempts = 0;
  await withServer((req, res) => {
    attempts += 1;
    keys.push(req.headers["idempotency-key"]);
    if (attempts === 1) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ __all__: { message: "Service unavailable" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "p1", status: "paid" }));
  }, async (baseUrl) => {
    const client = createClient({ baseUrl, timeoutMs: 5_000, maxRetries: 2 });
    const body = await client.request("POST", "/purchases/p1/charge/", { secretKey: "k", body: { recurring_token: "t" } });
    assert.equal(body.status, "paid");
  });
  assert.equal(attempts, 2);
  assert.equal(keys[0], keys[1], "a retried write must reuse its idempotency key");
});

test("retries are exhausted with a retryable error after maxRetries", async () => {
  let attempts = 0;
  await withServer((req, res) => {
    attempts += 1;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ __all__: { message: "Service unavailable", code: "gateway_down" } }));
  }, async (baseUrl) => {
    const client = createClient({ baseUrl, timeoutMs: 5_000, maxRetries: 1 });
    await assert.rejects(
      () => client.request("GET", "/purchases/p1/", { secretKey: "k" }),
      (error) => {
        assert.equal(error.retryable, true);
        assert.equal(error.status, 503);
        assert.equal(error.apiCode, "gateway_down");
        return true;
      },
    );
  });
  assert.equal(attempts, 2, "maxRetries 1 means two attempts total");
});

test("an unreachable host becomes a retryable NETWORK_ERROR", async () => {
  const client = createClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 1_000, maxRetries: 0 });
  await assert.rejects(
    () => client.request("GET", "/purchases/p1/", { secretKey: "k" }),
    (error) => {
      assert.equal(error.code, "NETWORK_ERROR");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("an already-aborted caller signal reports ABORTED rather than a network failure", async () => {
  let attempts = 0;
  await withServer((req, res) => {
    attempts += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  }, async (baseUrl) => {
    const client = createClient({ baseUrl, timeoutMs: 5_000, maxRetries: 2 });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => client.request("GET", "/purchases/p1/", { secretKey: "k", signal: controller.signal }),
      { code: "ABORTED" },
    );
  });
  assert.equal(attempts, 0, "an aborted caller must not retry");
});

test("a server that never answers becomes a TIMEOUT", async () => {
  await withServer(() => {
    /* Intentionally never responds; the client's own abort must end the attempt. */
  }, async (baseUrl) => {
    const client = createClient({ baseUrl, timeoutMs: 1_000, maxRetries: 0 });
    await assert.rejects(
      () => client.request("GET", "/purchases/p1/", { secretKey: "k" }),
      (error) => {
        assert.equal(error.code, "TIMEOUT");
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });
});
