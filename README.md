# dsh-plugin-chip-collect

[CHIP Collect](https://chip-in.asia) payment tools for [DeepSeek Harness](https://github.com/wzul) — create FPX, DuitNow QR, e-wallet and card checkouts, track a purchase's real status, refund, capture, release, run recurring charges, and verify callback signatures.

Eleven `chip_collect_*` tools, one HTTP client, no build step. Plain ESM JavaScript, so a `git` install works without compiling anything.

---

## Install

```bash
dsh plugin --profile desktop add github:wzul/dsh-plugin-chip-collect
```

That adds the package to the profile's `dsh.profile.bundles`, so its `cordis.patch.yml` inserts the plugin row automatically. Restart the profile and the tools are live.

<details>
<summary>Installing by hand instead</summary>

Add the package to `~/.dsh/profiles/<profile>/package.json` and append the bundle, then add the row to your patch layer:

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": { "dsh-plugin-chip-collect": "github:wzul/dsh-plugin-chip-collect" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-chip-collect"]
    }
  }
}
```

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- insert:
    - id: chip-collect
      name: dsh-plugin-chip-collect/plugin
      config:
        brandId: 409eb80e-3782-4b1d-afa8-b779759266a5
        secretKeyEnv: CHIP_COLLECT_SECRET_KEY
```

</details>

## Configure

| Field | Default | Meaning |
| --- | --- | --- |
| `secretKey` | — | Literal secret key. Prefer the credentials store instead. |
| `secretKeyEnv` | `CHIP_COLLECT_SECRET_KEY` | Credentials-store entry **or** environment variable holding the key. |
| `brandId` | — | Default brand UUID, so you need not pass one on every call. |
| `baseUrl` | `https://gate.chip-in.asia/api/v1` | Same host for test and live; the key decides which mode you are in. |
| `currency` | `MYR` | Default currency for created purchases. |
| `timeoutMs` | `30000` | Per-attempt HTTP timeout. |
| `toolTimeoutMs` | `60000` | Budget reported to each tool. |
| `maxRetries` | `2` | Extra attempts for a 429, a 5xx, or a transport failure. |

### Where the secret key comes from

Resolved **per request**, in this order:

1. `secretKey`, if you set it literally.
2. The DSH credentials store at `secretKeyEnv` — this covers both a key you stored through the desktop UI and the launching environment.
3. `process.env[secretKeyEnv]`.

If none yields a key, the tool call fails with `MISSING_SECRET_KEY` naming the reference it looked for. Nothing is read at plugin load, so a profile with no key still starts and still shows the tools.

Get a key from **CHIP Portal → Collect → Developers → API keys**. A test-mode key produces test purchases (`is_test: true`); a live key moves real money. They are separate datasets — test webhooks never fire for live purchases, and vice versa.

## Tools

| Tool | What it does |
| --- | --- |
| `chip_collect_create_purchase` | Create a purchase and return its `checkout_url`. |
| `chip_collect_get_purchase` | Read one purchase — **the** server-side status check. |
| `chip_collect_cancel_purchase` | Cancel a purchase that is still payable. |
| `chip_collect_refund_purchase` | Full or partial refund of a paid purchase. |
| `chip_collect_capture_purchase` | Capture funds held by `skip_capture`, optionally partially. |
| `chip_collect_release_purchase` | Release funds held by `skip_capture` without charging. |
| `chip_collect_charge_recurring` | Charge a saved `recurring_token`. |
| `chip_collect_list_payment_methods` | Which methods this brand, currency and amount can actually offer. |
| `chip_collect_get_account_balance` | Company balance, optionally filtered. |
| `chip_collect_verify_webhook_signature` | Verify an `X-Signature` against the raw body. |
| `chip_collect_api_request` | Any other **documented** endpoint: clients, webhooks, company statements, `mark_as_paid`, `resend_invoice`, `delete_recurring_token`, turnover. |

### Amounts are integers in minor units

Every amount is in the currency's minor unit. `1000` is **RM 10.00**, not RM 1000. The tools never accept a decimal string, so a mistaken `"10.00"` fails loudly rather than charging ten ringgit or one thousand.

### There is no "list purchases" tool

The CHIP Collect OpenAPI document defines no `GET /purchases/`. A purchase is only ever read by id, so this plugin does not offer a list — and `chip_collect_api_request` rejects it rather than inventing a path. Reconciliation means iterating the purchase ids you already stored, or reading `chip_collect_get_account_balance` and company statements.

### The generic tool is allowlisted

`chip_collect_api_request` matches `method` + `path` against the 33 operations transcribed from the CHIP Collect OpenAPI document **before** sending anything. Every path is plural with a trailing slash. An undocumented path — `/refunds/`, `/captures/`, `/charges/`, `/products/`, `/payouts/`, `/customers/` — fails with `UNSUPPORTED_ENDPOINT` and prints the operations that do exist, instead of 404ing against the vendor.

## Webhooks and callbacks

CHIP signs each callback with an RSASSA-PKCS1-v1_5 signature over the **SHA-256 digest of the raw request body**, base64-encoded in the `X-Signature` header.

`chip_collect_verify_webhook_signature` takes `signature` and `body` as strings. Verification only succeeds on the **byte-for-byte** body, so read it before any JSON parsing and never re-serialize it first — a `JSON.stringify(JSON.parse(body))` round-trip changes the bytes and invalidates the signature.

- **Success callbacks** (`success_callback`): omit `publicKey` and the tool fetches the company key from `GET /public_key/`, which responds with a *JSON-encoded* PEM string. The tool decodes it for you.
- **Webhook subscriptions**: pass the subscription's own `public_key` as `publicKey`; the company key will not verify it.

A tool result of `verified: false` is a definite verdict (tampered, wrong key, or a re-serialized body), not an error. Missing inputs are reported by name: `MISSING_SIGNATURE`, `MISSING_BODY`, `MISSING_PUBLIC_KEY`.

**Never treat a redirect as proof of payment.** Return-URL query parameters are attacker-controllable. After a redirect, call `chip_collect_get_purchase` and check `status` server-side.

## Idempotency

Every write carries an `Idempotency-Key`. One is generated per logical operation and **reused across retries**, so a retried refund cannot refund twice. Pass `idempotencyKey` explicitly to make a write replay-safe across separate tool calls.

Retries apply to `429`, `5xx`, and transport failures, with exponential backoff and full jitter, honoring `Retry-After`. A caller abort is never retried. A `4xx` is fatal on the first attempt.

## Security notes

- A `recurring_token` is a payment credential: it can move money with no customer present. It is returned by the API, so it will appear in tool output — do not echo it into user-facing prose, logs, or files.
- `baseUrl` refuses plain `http://` on anything but loopback, because the bearer token travels on every request.
- The secret key is never logged, and error messages carry the vendor's own message and code only.

## Test mode

Use a test-mode key, then pay on the hosted page with a CHIP test card:

| Card number | Behaviour |
| --- | --- |
| `4444 3333 2222 1111` | Succeeds without 3-D Secure |
| `5555 5555 5555 4444` | Succeeds with 3-D Secure |

Any cardholder name, any expiry at or after the current month, CVC `123`.

## Development

```bash
node --test test/*.test.js
```

47 tests, no dependencies beyond Node's standard library. The HTTP tests bind a real throwaway server on a loopback port, so retry, idempotency, timeout, and abort behaviour are exercised end to end.

```
lib/
  index.js       plugin entry: config, secret-key resolution, prompt section
  tools.js       the 11 tool definitions
  client.js      HTTP client: retries, idempotency keys, error translation
  endpoints.js   the documented-operation allowlist
  signature.js   RSA-SHA256 callback verification
  views.js       response projections and text formatting
  errors.js      one error type
  version.js     name and version
  bundle.js      no-op bundle entry
```

The plugin declares `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-credentials` and `@deepseek-ai/schemastery` as **peer** dependencies, because the DSH runtime already provides all three.

## License

MIT — see [LICENSE](LICENSE).
