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
  // Cursor rule files — `.cursor/rules/*.mdc` are markdown-with-frontmatter
  // agent-instruction files; the canonical place a coding agent reads its prose.
  "mdc",
  // test fixtures / raw payloads
  "txt",
];

/**
 * Extensionless agent-instruction dotfiles. `.cursorrules` (and friends) carry
 * the agent's project-level instructions but have no extension, so the
 * extension glob never sees them — they must be matched by exact basename.
 * Their absence meant a payload in `.cursorrules` scanned as a false "clean".
 */
const SCAN_BASENAMES = [".cursorrules", ".windsurfrules", ".clinerules"];

/**
 * Noise that never contains hand-authored prose worth classifying, anywhere in
 * the tree: `.git`, minified bundles, source maps, and lockfiles. These are safe
 * to skip everywhere because they hold no agent-readable prose regardless of
 * where they live.
 */
const ALWAYS_IGNORE = [
  "**/.git/**",
  "**/*.min.js",
  "**/*.map",
  "**/*-lock.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/*.lock",
];

/**
 * Build-output directories that hold a project's *own* generated artifacts — and
 * so are noise in the project root — but, inside `node_modules`, hold a published
 * package's REAL, executed code (e.g. `node_modules/yaml/dist`,
 * `node_modules/tsx/dist`). The old, recursive "globstar dist globstar" form
 * (a leading globstar + `dist` + a trailing globstar) used to apply to the whole
 * tree, blanket-skipping `node_modules/<pkg>/dist|build|.next|coverage` — the
 * exact dependency code a coding agent ingests and runs — so a supply-chain
 * payload there scanned as a false "clean". These patterns are therefore anchored
 * to the project root (no leading globstar; resolved from the walk `cwd`) so the
 * project's own build output is still skipped while dependency code under
 * `node_modules` is scanned.
 */
const ROOT_BUILD_ARTIFACT_IGNORE = [
  "dist/**",
  "build/**",
  ".next/**",
  "coverage/**",
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

  // Always-noise everywhere + the project's own build output (root-anchored, so it
  // does NOT swallow dependency code under node_modules/<pkg>/dist|build|.next|coverage).
  const ignore = [...ALWAYS_IGNORE, ...ROOT_BUILD_ARTIFACT_IGNORE];
  if (!includeDeps) {
    ignore.push("**/node_modules/**");
  }

  // Two globs: every scannable extension, plus the exact-basename agent dotfiles
  // (`.cursorrules` et al.) that have no extension for the first glob to match.
  const patterns = [
    `**/*.{${SCAN_EXTENSIONS.join(",")}}`,
    ...SCAN_BASENAMES.map((name) => `**/${name}`),
  ];

  const entries = await fg(patterns, {
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
