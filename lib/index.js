/**
 * CHIP Collect for DeepSeek Harness.
 *
 * A Cordis plugin that registers the `chip_collect_*` tools and a short prompt
 * section that keeps the model honest about two things that are easy to get wrong:
 * amounts are integers in minor units, and a payment is only real once CHIP says so
 * on the server side.
 *
 * ```jsonc
 * // ~/.dsh/profiles/<profile>/cordis.patch.yml
 * - id: chip-collect
 *   config:
 *     brandId: 409eb80e-3782-4b1d-afa8-b779759266a5
 *     secretKeyEnv: CHIP_COLLECT_SECRET_KEY
 * ```
 *
 * @module dsh-plugin-chip-collect
 */
import z from "@deepseek-ai/schemastery";
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { DEFAULT_BASE_URL, createClient } from "./client.js";
import { missingSecretKeyError } from "./errors.js";
import { registerChipCollectTools } from "./tools.js";

/** Stable plugin id; also the row id the shipped bundle patch uses. */
export const name = "chip-collect";

/**
 * The only service this plugin cannot work without.
 *
 * `credentials` and `systemPrompt` are deliberately absent: both are reached through
 * `ctx.get(...)` so the plugin still loads — with an environment-variable fallback
 * and no prompt section — if a profile does not provide them.
 */
export const inject = ["tools"];

/** Credentials-store reference consulted when no literal key is configured. */
const DEFAULT_SECRET_KEY_ENV = "CHIP_COLLECT_SECRET_KEY";

/** Prompt section name. Unique, so a re-registration replaces rather than duplicates. */
const SECTION_NAME = "tool:chip_collect";

/**
 * Placement of this plugin's prompt section.
 *
 * DSH's `SECTION_ORDERS` table reserves slots for its own tools up to `TOOL_COMPUTER_USE`
 * (3000) and `MCP_SERVERS` (3100). Sitting just after the built-in tool sections keeps
 * the payment guidance next to the other tool guidance without shadowing a reserved name.
 */
const SECTION_ORDER = 2_550;

/**
 * Prompt text, emitted only while the tools are actually registered.
 *
 * The two rules here are the two ways an agent most often gets payments wrong:
 * treating a redirect or callback as proof of payment, and misreading minor units.
 */
const SECTION_TEXT = [
  "CHIP Collect payments are available through the `chip_collect_*` tools.",
  "Amounts are always integers in the currency's minor unit (sen): 1000 is RM 10.00, not RM 1000.",
  "A purchase is only paid once CHIP confirms it server-side: call chip_collect_get_purchase after a return-URL "
    + "redirect instead of trusting redirect query parameters, and treat a callback payload as untrusted until "
    + "chip_collect_verify_webhook_signature returns true.",
  "A `recurring_token` is a payment credential that can move money without the customer present — never print it in "
    + "user-facing prose and never write it to a file.",
].join(" ");

/** Plugin settings. Every field is optional so an install works before it is configured. */
export const Config = z.object({
  secretKey: z.string().role("secret")
    .description("Literal CHIP Collect secret key. Prefer the credentials store or the environment reference instead."),
  secretKeyEnv: z.string().role("credential-ref").default(DEFAULT_SECRET_KEY_ENV)
    .description("Name of the credentials-store entry or environment variable holding the secret key."),
  brandId: z.string()
    .description("Default brand UUID. Obtain one at https://portal.chip-in.asia/collect/developers/brands."),
  baseUrl: z.string().default(DEFAULT_BASE_URL)
    .description("API base URL. The same host serves test and live; the key decides which one you are in."),
  currency: z.string().default("MYR")
    .description("Default ISO 4217 currency for created purchases."),
  timeoutMs: z.number().step(1).min(1_000).default(30_000)
    .description("Per-attempt HTTP timeout in milliseconds."),
  toolTimeoutMs: z.number().step(1).min(1_000).default(60_000)
    .description("Cooperative timeout budget reported to each tool."),
  maxRetries: z.number().step(1).min(0).max(5).default(2)
    .description("Extra attempts for a 429, a 5xx, or a transport failure."),
});

/**
 * Resolve the CHIP Collect secret key, preferring the least exposed source.
 *
 * Order: an explicitly configured literal, then the DSH credentials store, then the
 * environment of the process that launched DeepSeek Harness. The credentials store is
 * asked first because it covers both the provider-managed store and the ambient
 * environment, so a key set up in the desktop UI keeps working without a profile edit.
 *
 * @param ctx - Plugin context, used to reach the optional `credentials` service.
 * @param config - Resolved plugin configuration.
 * @returns The trimmed secret key.
 * @throws {import('./errors.js').ChipCollectError} When no source yields a key.
 */
async function resolveSecretKey(ctx, config) {
  const literal = typeof config.secretKey === "string" ? config.secretKey.trim() : "";
  if (literal.length > 0) return literal;

  const reference = typeof config.secretKeyEnv === "string" && config.secretKeyEnv.length > 0
    ? config.secretKeyEnv
    : DEFAULT_SECRET_KEY_ENV;

  const credentials = ctx.get("credentials");
  if (credentials !== undefined && typeof credentials.resolve === "function" && isCredentialRefName(reference)) {
    try {
      const found = await credentials.resolve(credentialRef(reference));
      const value = typeof found?.value === "string" ? found.value.trim() : "";
      if (value.length > 0) return value;
    } catch {
      /* A store failure must not mask the actionable error thrown below, which names
         every source the operator can fix. */
    }
  }

  const ambient = process.env[reference];
  if (typeof ambient === "string" && ambient.trim().length > 0) return ambient.trim();

  throw missingSecretKeyError(reference);
}

/**
 * Register the CHIP Collect tools and prompt section.
 *
 * The HTTP client is built on first use rather than here, so a mistyped `baseUrl`
 * surfaces as one actionable tool error instead of a plugin that refuses to load
 * and takes the rest of the profile's tools with it.
 *
 * @param ctx - Plugin context whose `tools` registry receives the definitions.
 * @param config - Resolved plugin configuration.
 */
export function apply(ctx, config) {
  let client;
  const api = {
    config,
    toolTimeoutMs: config.toolTimeoutMs,
    /**
     * Issue one allowlisted CHIP Collect request with a freshly resolved key.
     *
     * @param method - HTTP method.
     * @param path - Path beginning with `/`.
     * @param options - Query, body, idempotency key, and cancellation signal.
     * @returns The parsed response body.
     */
    async request(method, path, options = {}) {
      client ??= createClient({
        baseUrl: config.baseUrl,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
      });
      const secretKey = await resolveSecretKey(ctx, config);
      return client.request(method, path, { ...options, secretKey });
    },
  };

  registerChipCollectTools(ctx, api);

  const systemPrompt = ctx.get("systemPrompt");
  systemPrompt?.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: ({ scope }) => (ctx.tools.get("chip_collect_create_purchase", scope) === undefined ? "" : SECTION_TEXT),
  });
}

export { DEFAULT_BASE_URL, DEFAULT_SECRET_KEY_ENV };
