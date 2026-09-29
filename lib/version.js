/**
 * Plugin version stamped into the `User-Agent` header CHIP Collect receives.
 *
 * Kept as a literal rather than read from `package.json` so the plugin stays a
 * plain ESM module with no JSON import attributes or build step. Keep it in sync
 * with the `version` field of `package.json` when releasing.
 *
 * @module dsh-plugin-chip-collect/version
 */
export const PLUGIN_VERSION = "1.0.0";

/** Package name used in `User-Agent` and every user-facing error message. */
export const PLUGIN_NAME = "dsh-plugin-chip-collect";
