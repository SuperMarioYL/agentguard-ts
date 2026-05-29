/**
 * walk.ts — enumerate candidate files in a project and (optionally) its
 * dependency tree.
 *
 * Returns absolute paths for every file whose extension carries
 * natural-language prose an agent might ingest (source comments + string
 * literals, Markdown, YAML/JSON manifests, plain-text fixtures). `extract.ts`
 * decides how to pull prose out of each; this module only decides *which*
 * files are worth opening.
 */

import path from "node:path";
import fg from "fast-glob";

export interface WalkOptions {
  /** Also walk node_modules / the dependency tree (default true). */
  includeDeps?: boolean;
}

/**
 * Extensions that can carry prose addressed to a coding agent. Anything not in
 * this list (binaries, lockfiles, source maps) is never opened.
 */
const SCAN_EXTENSIONS = [
  // JS / TS source — comments + string literals
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
  // Python source — comments + docstrings
  "py",
  // docs
  "md",
  "markdown",
  // manifests (incl. MCP tool descriptions)
  "yaml",
  "yml",
  "json",
  // test fixtures / raw payloads
  "txt",
];

/**
 * Directories and noise files that never contain hand-authored prose worth
 * classifying. Lockfiles and minified bundles are excluded so the unit count
 * stays meaningful. `.git` is always skipped even though we walk other dotfiles
 * (e.g. `.cursor/`, `.mcp.json`) on purpose — those carry agent instructions.
 */
const ALWAYS_IGNORE = [
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.map",
  "**/*-lock.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/*.lock",
];

/**
 * Walk `rootDir`, returning absolute paths of every scannable file. With
 * `includeDeps` (the default), node_modules is walked too — that is where the
 * supply-chain payloads live; nobody reads their transitive deps by hand.
 */
export async function walk(
  rootDir: string,
  opts: WalkOptions = {},
): Promise<string[]> {
  const includeDeps = opts.includeDeps ?? true;

  const ignore = [...ALWAYS_IGNORE];
  if (!includeDeps) {
    ignore.push("**/node_modules/**");
  }

  const pattern = `**/*.{${SCAN_EXTENSIONS.join(",")}}`;

  const entries = await fg(pattern, {
    cwd: path.resolve(rootDir),
    absolute: true,
    onlyFiles: true,
    // Walk dotfiles/dirs (`.cursor/`, `.mcp.json`) — they carry agent prose —
    // but `.git` stays excluded via ALWAYS_IGNORE.
    dot: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore,
  });

  return entries;
}
