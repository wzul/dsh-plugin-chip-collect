/**
 * Bundle half of `dsh-plugin-chip-collect`.
 *
 * A DSH bundle package needs a `main` entry that the package manager and the profile
 * loader can resolve — but a bundle does its work entirely through its
 * `cordis.patch.yml`, which inserts the real plugin row
 * (`dsh-plugin-chip-collect/plugin`). This module therefore exports nothing; it exists
 * so `import "dsh-plugin-chip-collect"` and `require("dsh-plugin-chip-collect")`
 * resolve cleanly instead of failing on a missing file.
 *
 * @module dsh-plugin-chip-collect/bundle
 */
export {};
