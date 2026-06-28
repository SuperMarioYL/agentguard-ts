/**
 * version.ts — the single source of truth for the tool's version.
 *
 * Both the CLI `--version` flag (cli.ts) and the machine-readable `--json`
 * output (report.ts) read from here, so they can never drift apart again.
 * The value is read from package.json at runtime via createRequire, which
 * resolves correctly from both the compiled `dist/` (package.json one level up)
 * and `tsx`-run `src/` (package.json one level up) — no second hardcoded string.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };

/** The published version, sourced once from package.json. */
export const VERSION: string = pkg.version ?? "0.0.0";
