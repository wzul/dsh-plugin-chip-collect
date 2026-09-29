/**
 * Unit tests for callback signature verification.
 *
 * The fixtures sign with a real 2048-bit RSA key using the algorithm the CHIP
 * Collect spec names: an RSASSA-PKCS1-v1_5 signature over the SHA-256 digest of the
 * raw body, base64-encoded into `X-Signature`.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  describeVerification,
  normalizePublicKeyText,
  parsePublicKey,
  verifyCallback,
} from "../lib/signature.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

/**
 * A representative success-callback body, kept as a string so its bytes are stable.
 *
 * It carries the whitespace a real JSON encoder might emit, which is exactly what
 * makes the re-serialization test meaningful.
 */
const BODY = '{ "id": "p1", "status": "paid", "event_type": "purchase.paid" }';

/**
 * Sign a body the way CHIP documents it.
 *
 * @param body - Raw body text.
 * @returns The base64 `X-Signature` value.
 */
function signBody(body) {
  return sign("RSA-SHA256", Buffer.from(body, "utf8"), privateKey).toString("base64");
}

test("a correctly signed body verifies", () => {
  assert.equal(verifyCallback({ signature: signBody(BODY), body: BODY, publicKey: PEM }), true);
});

test("a parsed KeyObject is accepted as well as PEM text", () => {
  assert.equal(verifyCallback({ signature: signBody(BODY), body: BODY, publicKey: parsePublicKey(PEM) }), true);
});

test("tampering with one byte of the body fails verification", () => {
  const signature = signBody(BODY);
  assert.equal(verifyCallback({ signature, body: BODY.replace('"paid"', '"hold"'), publicKey: PEM }), false);
});

test("re-serializing the same JSON fails, because the bytes changed", () => {
  const signature = signBody(BODY);
  const reserialized = JSON.stringify(JSON.parse(BODY));
  assert.equal(verifyCallback({ signature, body: reserialized, publicKey: PEM }), false);
});

test("a signature from a different key fails instead of throwing", () => {
  const other = generateKeyPairSync("rsa", { modulusLength: 2_048 });
  const foreign = sign("RSA-SHA256", Buffer.from(BODY, "utf8"), other.privateKey).toString("base64");
  assert.equal(verifyCallback({ signature: foreign, body: BODY, publicKey: PEM }), false);
});

test("a GET /public_key/ body — a JSON-encoded PEM string — is decoded", () => {
  const jsonEncoded = JSON.stringify(PEM);
  assert.equal(normalizePublicKeyText(jsonEncoded), PEM.trim());
  assert.equal(verifyCallback({ signature: signBody(BODY), body: BODY, publicKey: jsonEncoded }), true);
});

test("a PEM whose newlines were escaped to a literal backslash-n still parses", () => {
  const escaped = PEM.trim().replace(/\n/gu, "\\n");
  assert.ok(!escaped.includes("\n"));
  assert.equal(verifyCallback({ signature: signBody(BODY), body: BODY, publicKey: escaped }), true);
});

test("missing inputs are reported by name rather than as a false verdict", () => {
  assert.throws(() => verifyCallback({ signature: "", body: BODY, publicKey: PEM }), { code: "MISSING_SIGNATURE" });
  assert.throws(() => verifyCallback({ signature: signBody(BODY), body: undefined, publicKey: PEM }), { code: "MISSING_BODY" });
  assert.throws(() => parsePublicKey(""), { code: "MISSING_PUBLIC_KEY" });
  assert.throws(() => parsePublicKey("-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----"), { code: "INVALID_PUBLIC_KEY" });
});

test("a non-RSA key is rejected as the wrong algorithm", () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecPem = ec.publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.throws(() => parsePublicKey(ecPem), { code: "INVALID_PUBLIC_KEY" });
});

test("the verdict text names the event and says what to do", () => {
  assert.match(describeVerification(true, "purchase.paid"), /valid for the "purchase\.paid" callback/u);
  assert.match(describeVerification(false, "purchase.paid"), /does NOT match/u);
  assert.match(describeVerification(false), /treat the delivery as untrusted/u);
});
