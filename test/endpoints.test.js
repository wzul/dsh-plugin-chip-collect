/**
 * Unit tests for the documented-endpoint allowlist.
 *
 * The point of these tests is the negative space: the plugin must refuse an
 * operation the CHIP Collect OpenAPI document does not define, including the
 * `/purchases/` list endpoint that does not exist.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ENDPOINTS, describeEndpoints, matchEndpoint, normalizePath } from "../lib/endpoints.js";

test("the allowlist matches the documented operation count", () => {
  assert.equal(ENDPOINTS.length, 33);
  assert.equal(describeEndpoints().split("\n").length, 33);
  const ids = new Set(ENDPOINTS.map((endpoint) => endpoint.id));
  assert.equal(ids.size, ENDPOINTS.length, "every operation id must be unique");
});

test("every documented path is plural, slash-terminated, and safely shaped", () => {
  for (const endpoint of ENDPOINTS) {
    assert.match(endpoint.method, /^(GET|POST|PUT|PATCH|DELETE)$/u, `${endpoint.path} method`);
    assert.ok(endpoint.path.startsWith("/"), `${endpoint.path} must start with /`);
    assert.ok(endpoint.path.endsWith("/"), `${endpoint.path} must end with /`);
    assert.ok(!endpoint.path.includes("//"), `${endpoint.path} must not contain //`);
    assert.ok(endpoint.summary.length > 0, `${endpoint.path} needs a summary`);
  }
});

test("there is no list-purchases operation, because CHIP does not document one", () => {
  assert.equal(matchEndpoint("GET", "/purchases/"), undefined);
  assert.notEqual(matchEndpoint("POST", "/purchases/"), undefined);
});

test("undocumented collections are refused", () => {
  for (const [method, path] of [
    ["GET", "/refunds/"],
    ["POST", "/refunds/"],
    ["GET", "/captures/"],
    ["GET", "/products/"],
    ["GET", "/payouts/"],
    ["GET", "/customers/"],
    ["GET", "/customers/abc/"],
    ["PUT", "/purchases/"],
  ]) {
    assert.equal(matchEndpoint(method, path), undefined, `${method} ${path} must not match`);
  }
});

test("a purchase sub-resource resolves to its operation and parameters", () => {
  const matched = matchEndpoint("POST", "/purchases/9f0d1c2e-4d3b/refund/");
  assert.equal(matched?.id, "purchases.refund");
  assert.deepEqual(matched?.params, { id: "9f0d1c2e-4d3b" });
});

test("a nested token route captures both placeholders", () => {
  const matched = matchEndpoint("DELETE", "/clients/client-1/recurring_tokens/purchase-2/");
  assert.equal(matched?.id, "clients.delete-recurring-token");
  assert.deepEqual(matched?.params, { client_id: "client-1", purchase_id: "purchase-2" });
});

test("the trailing slash is optional on input and restored in the match", () => {
  assert.equal(matchEndpoint("POST", "/purchases/abc/refund")?.id, "purchases.refund");
  assert.equal(matchEndpoint("GET", "/account/json/balance")?.id, "account.balance");
});

test("a duplicate slash collapses rather than matching a different route", () => {
  assert.equal(matchEndpoint("GET", "//webhooks//")?.id, "webhooks.list");
});

test("normalizePath rejects absolute URLs, traversal, and empty input", () => {
  assert.throws(() => normalizePath("https://gate.chip-in.asia/api/v1/purchases/"), { code: "INVALID_PATH" });
  assert.throws(() => normalizePath("/purchases/../../etc/passwd"), { code: "INVALID_PATH" });
  assert.throws(() => normalizePath("purchases/"), { code: "INVALID_PATH" });
  assert.throws(() => normalizePath(""), { code: "INVALID_PATH" });
});

test("normalizePath accepts a bare route and adds the trailing slash", () => {
  assert.equal(normalizePath("/payment_methods"), "/payment_methods/");
  assert.equal(normalizePath("/payment_methods/"), "/payment_methods/");
});

test("matchEndpoint is case-insensitive about the method only", () => {
  assert.equal(matchEndpoint("post", "/purchases/abc/cancel/")?.id, "purchases.cancel");
  assert.equal(matchEndpoint("GET", "/PURCHASES/abc/"), undefined);
});
