/**
 * Error types this plugin throws.
 *
 * Every failure the tools can produce is a {@link ChipCollectError}, so a caller
 * (or the model reading the tool result) can always rely on the same fields:
 * a human-readable `message`, a stable `code`, and — for API failures — the HTTP
 * `status` and CHIP's own error code.
 *
 * @module dsh-plugin-chip-collect/errors
 */
import { PLUGIN_NAME } from "./version.js";

/**
 * Base error for every failure raised by this plugin.
 *
 * `code` is stable and machine-readable; CHIP's own code (for example
 * `invalid_recurring_token`) is preserved in `apiCode` so it is never confused
 * with a plugin-level code such as `MISSING_SECRET_KEY`.
 */
export class ChipCollectError extends Error {
  /**
   * @param message - Human-readable, actionable description.
   * @param options - Failure metadata.
   * @param options.code - Stable plugin-level code.
   * @param options.status - HTTP status, when the failure came from a response.
   * @param options.apiCode - CHIP's own error code from the response body.
   * @param options.retryable - Whether retrying the same request could succeed.
   * @param options.details - Structured extra context worth surfacing.
   * @param options.cause - The underlying error, when there is one.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChipCollectError";
    this.code = options.code ?? "CHIP_COLLECT_ERROR";
    this.status = options.status;
    this.apiCode = options.apiCode;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/**
 * Build the failure raised when no CHIP Collect secret key can be resolved.
 *
 * The message names all three supported sources so the fix is obvious without
 * reading the README: a literal config value, the DSH credentials store, or the
 * launching process environment.
 *
 * @param reference - The environment-variable-style reference that was consulted.
 * @returns A configuration error ready to throw.
 */
export function missingSecretKeyError(reference) {
  return new ChipCollectError(
    `CHIP Collect has no secret key: store one in the DSH credentials service under "${reference}", `
      + `export ${reference} in the environment that launches DeepSeek Harness, or set a literal "secretKey" `
      + `in the chip-collect config. Get a key from https://portal.chip-in.asia/collect/developers/api-keys.`,
    { code: "MISSING_SECRET_KEY" },
  );
}

/**
 * Build the failure raised when a caller asks a tool for an operation the CHIP
 * Collect OpenAPI spec does not document.
 *
 * @param method - The rejected HTTP method.
 * @param path - The rejected request path.
 * @param allowed - Human-readable list of the documented operations.
 * @returns A configuration error ready to throw.
 */
export function unsupportedEndpointError(method, path, allowed) {
  return new ChipCollectError(
    `${method} ${path} is not a documented CHIP Collect endpoint, so ${PLUGIN_NAME} will not call it. `
      + `Documented operations:\n${allowed}`,
    { code: "UNSUPPORTED_ENDPOINT" },
  );
}
