/**
 * The documented CHIP Collect endpoint allowlist.
 *
 * Transcribed one-for-one from the paths in the CHIP Collect OpenAPI document
 * (<https://docs.chip-in.asia/openapi/chip-collect.yaml>, OpenAPI 3.1.0, server
 * `https://gate.chip-in.asia/api/v1`). Every path is plural, ends in a trailing
 * slash, and nests sub-resources under `/purchases/{id}/`.
 *
 * The plugin never calls a path that is absent from this table, and the generic
 * `chip_collect_api_request` tool matches against it before issuing anything. That
 * keeps the plugin honest about the vendor contract: an operation CHIP does not
 * document is reported as unsupported rather than guessed at.
 *
 * Paths deliberately absent because the spec has no such resource: `/refunds/`,
 * `/captures/`, `/charges/`, `/products/`, `/payouts/`, `/customers/`, and any
 * list form of `/purchases/` (there is no `GET /purchases/` — a purchase is only
 * ever read by id).
 *
 * @module dsh-plugin-chip-collect/endpoints
 */
import { ChipCollectError } from "./errors.js";

/**
 * One documented operation.
 *
 * @typedef {object} Endpoint
 * @property {string} method - Uppercase HTTP method.
 * @property {string} path - Path template with `{name}` placeholders.
 * @property {string} id - Stable identifier used in error messages.
 * @property {string} summary - One-line description.
 */

/** @type {readonly Endpoint[]} */
export const ENDPOINTS = Object.freeze([
  // --- Purchases -----------------------------------------------------------
  { method: "POST", path: "/purchases/", id: "purchases.create", summary: "Create a purchase and get its checkout_url" },
  { method: "GET", path: "/purchases/{id}/", id: "purchases.retrieve", summary: "Retrieve one purchase (the server-side status check)" },
  { method: "POST", path: "/purchases/{id}/cancel/", id: "purchases.cancel", summary: "Cancel a still-payable purchase" },
  { method: "POST", path: "/purchases/{id}/release/", id: "purchases.release", summary: "Release funds held by skip_capture" },
  { method: "POST", path: "/purchases/{id}/capture/", id: "purchases.capture", summary: "Capture authorized funds, optionally partially" },
  { method: "POST", path: "/purchases/{id}/charge/", id: "purchases.charge", summary: "Charge a saved recurring_token" },
  { method: "POST", path: "/purchases/{id}/delete_recurring_token/", id: "purchases.delete-recurring-token", summary: "Clear is_recurring_token on a purchase" },
  { method: "POST", path: "/purchases/{id}/refund/", id: "purchases.refund", summary: "Refund a paid purchase, fully or partially" },
  { method: "POST", path: "/purchases/{id}/mark_as_paid/", id: "purchases.mark-as-paid", summary: "Mark a purchase paid out of band" },
  { method: "POST", path: "/purchases/{id}/resend_invoice/", id: "purchases.resend-invoice", summary: "Resend the invoice email" },

  // --- Payment methods -----------------------------------------------------
  { method: "GET", path: "/payment_methods/", id: "payment-methods.list", summary: "List payment methods available to a brand" },

  // --- Clients -------------------------------------------------------------
  { method: "POST", path: "/clients/", id: "clients.create", summary: "Create a client" },
  { method: "GET", path: "/clients/", id: "clients.list", summary: "List clients" },
  { method: "GET", path: "/clients/{id}/", id: "clients.retrieve", summary: "Retrieve one client" },
  { method: "PUT", path: "/clients/{id}/", id: "clients.replace", summary: "Replace a client" },
  { method: "PATCH", path: "/clients/{id}/", id: "clients.update", summary: "Update a client" },
  { method: "DELETE", path: "/clients/{id}/", id: "clients.delete", summary: "Delete a client" },
  { method: "GET", path: "/clients/{id}/recurring_tokens/", id: "clients.recurring-tokens", summary: "List a client's recurring tokens" },
  { method: "GET", path: "/clients/{client_id}/recurring_tokens/{purchase_id}/", id: "clients.recurring-token", summary: "Retrieve one client recurring token" },
  { method: "DELETE", path: "/clients/{client_id}/recurring_tokens/{purchase_id}/", id: "clients.delete-recurring-token", summary: "Delete one client recurring token" },

  // --- Webhooks ------------------------------------------------------------
  { method: "POST", path: "/webhooks/", id: "webhooks.create", summary: "Create a webhook subscription" },
  { method: "GET", path: "/webhooks/", id: "webhooks.list", summary: "List webhook subscriptions" },
  { method: "GET", path: "/webhooks/{id}/", id: "webhooks.retrieve", summary: "Retrieve one webhook subscription" },
  { method: "PUT", path: "/webhooks/{id}/", id: "webhooks.replace", summary: "Replace a webhook subscription" },
  { method: "PATCH", path: "/webhooks/{id}/", id: "webhooks.update", summary: "Update a webhook subscription" },
  { method: "DELETE", path: "/webhooks/{id}/", id: "webhooks.delete", summary: "Delete a webhook subscription" },

  // --- Public key ----------------------------------------------------------
  { method: "GET", path: "/public_key/", id: "public-key.retrieve", summary: "Get the PEM key that verifies success-callback signatures" },

  // --- Account -------------------------------------------------------------
  { method: "GET", path: "/account/json/balance/", id: "account.balance", summary: "Get the company balance by currency" },
  { method: "GET", path: "/account/json/turnover/", id: "account.turnover", summary: "Get the company turnover for one currency" },

  // --- Company statements --------------------------------------------------
  { method: "POST", path: "/company_statements/", id: "company-statements.create", summary: "Request a company statement" },
  { method: "GET", path: "/company_statements/", id: "company-statements.list", summary: "List company statements" },
  { method: "GET", path: "/company_statements/{id}/", id: "company-statements.retrieve", summary: "Retrieve one company statement" },
  { method: "POST", path: "/company_statements/{id}/cancel/", id: "company-statements.cancel", summary: "Cancel a company statement request" },
]);

/** Placeholder pattern shared by every template: `{id}`, `{client_id}`, `{purchase_id}`. */
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

/**
 * Compile one path template into an anchored matcher plus the ordered placeholder
 * names it captured.
 *
 * @param template - Path template such as `/purchases/{id}/refund/`.
 * @returns A matcher and the placeholder names in path order.
 */
function compileTemplate(template) {
  const names = [];
  let pattern = "";
  let cursor = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    pattern += escapeRegExp(template.slice(cursor, index));
    pattern += "([^/?#]+)";
    names.push(match[1]);
    cursor = index + match[0].length;
  }
  pattern += escapeRegExp(template.slice(cursor));
  return { matcher: new RegExp(`^${pattern}$`, "u"), names };
}

/**
 * Escape the literal segments a path template contributes to a regular expression.
 *
 * @param value - Literal text.
 * @returns The text with regular-expression metacharacters escaped.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const COMPILED = ENDPOINTS.map((endpoint) => ({ ...endpoint, ...compileTemplate(endpoint.path) }));

/**
 * Normalize a caller-supplied path: collapse duplicate slashes, require a leading
 * slash, require the trailing slash CHIP expects, and reject traversal or an
 * embedded origin.
 *
 * @param path - Raw path from a tool argument.
 * @returns The normalized path.
 * @throws {import('./errors.js').ChipCollectError} When the path is not a safe relative path.
 */
export function normalizePath(path) {
  const raw = String(path ?? "").trim();
  if (raw.length === 0) throw pathError("a request path is required, for example /purchases/");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(raw)) throw pathError(`"${raw}" is an absolute URL; pass only the path, for example /purchases/`);
  if (!raw.startsWith("/")) throw pathError(`"${raw}" must start with "/"`);
  if (raw.includes("..")) throw pathError(`"${raw}" must not contain ".."`);
  const collapsed = raw.replace(/\/{2,}/gu, "/");
  return collapsed.endsWith("/") ? collapsed : `${collapsed}/`;
}

/**
 * Build the rejection raised for an unusable path argument.
 *
 * @param message - Why the path was rejected.
 * @returns An error ready to throw.
 */
function pathError(message) {
  return new ChipCollectError(message, { code: "INVALID_PATH" });
}

/**
 * Match a method and path against the documented allowlist.
 *
 * @param method - HTTP method, any case.
 * @param path - Request path, with or without its trailing slash.
 * @returns The matched endpoint with its captured parameters, or `undefined`.
 */
export function matchEndpoint(method, path) {
  const upper = String(method ?? "").trim().toUpperCase();
  const normalized = normalizePath(path);
  for (const endpoint of COMPILED) {
    if (endpoint.method !== upper) continue;
    const match = endpoint.matcher.exec(normalized);
    if (match === null) continue;
    /** @type {Record<string, string>} */
    const params = {};
    endpoint.names.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1]);
    });
    return { id: endpoint.id, method: endpoint.method, path: endpoint.path, summary: endpoint.summary, params };
  }
  return undefined;
}

/**
 * Render the allowlist for an error message or tool description.
 *
 * @returns One `METHOD /path/` line per documented operation.
 */
export function describeEndpoints() {
  return ENDPOINTS.map((endpoint) => `${endpoint.method} ${endpoint.path}`).join("\n");
}
