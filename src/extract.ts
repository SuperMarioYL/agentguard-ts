/**
 * extract.ts — turn raw files into a normalized stream of natural-language
 * `TextUnit`s, each tagged with where it came from and what kind of prose it is.
 *
 * Per file type:
 *   - JS/TS  → comments + string/template literals via @babel/parser
 *   - Python → `#` comments + triple-quoted docstrings via regex
 *   - Markdown → non-empty body lines
 *   - YAML/JSON → string scalars (a `description` key marks an MCP tool desc)
 *   - .txt / anything under a fixtures dir → raw lines as fixtures
 *
 * Classification (rules.ts) happens downstream; this module is content-only and
 * never decides whether a unit is hostile.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as babelParse } from "@babel/parser";
import {
  parseAllDocuments,
  LineCounter,
  visit,
  isPair,
  isScalar,
} from "yaml";
import type { TextUnit, SourceKind } from "./scanner.js";

/** Skip files larger than this — payloads are prose, not megabyte blobs. */
const MAX_FILE_BYTES = 2_000_000;

const JS_TS_EXT = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

/**
 * Extensionless agent-instruction dotfiles (kept in sync with walk.ts's
 * SCAN_BASENAMES). They carry plain agent prose and are extracted line-based.
 */
const AGENT_INSTRUCTION_BASENAMES = new Set([
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
]);

/**
 * Extract normalized prose units from a list of file paths. Files that can't be
 * read or parsed are skipped so one bad file never aborts the scan.
 */
export async function extract(files: string[]): Promise<TextUnit[]> {
  const units: TextUnit[] = [];

  for (const file of files) {
    // Guard on the real byte size BEFORE reading: string.length counts UTF-16
    // code units, so a multibyte (e.g. CJK) file can sit under a char-count
    // limit while being multiple MB on disk. stat() lets us skip oversized files
    // without ever pulling them into memory.
    let byteSize: number;
    try {
      byteSize = (await stat(file)).size;
    } catch {
      continue;
    }
    if (byteSize === 0 || byteSize > MAX_FILE_BYTES) continue;

    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (content.length === 0) continue;

    try {
      // A file living under a fixtures dir is treated as raw payload data
      // regardless of extension — that is what test fixtures are.
      if (isFixturePath(file)) {
        extractLineBased(file, content, "fixture", units);
        continue;
      }

      const ext = path.extname(file).toLowerCase();
      const base = path.basename(file).toLowerCase();
      if (JS_TS_EXT.has(ext)) {
        extractJsTs(file, content, units);
      } else if (ext === ".py") {
        extractPython(file, content, units);
      } else if (
        ext === ".md" ||
        ext === ".markdown" ||
        // Cursor `.mdc` rule files are markdown-with-frontmatter; treat as
        // markdown so their agent-instruction prose is extracted line by line.
        ext === ".mdc" ||
        // Extensionless agent-instruction dotfiles (`.cursorrules` et al.) hold
        // plain agent prose — line-based extraction, same as markdown.
        AGENT_INSTRUCTION_BASENAMES.has(base)
      ) {
        extractLineBased(file, content, "markdown", units);
      } else if (ext === ".yaml" || ext === ".yml" || ext === ".json") {
        extractStructured(file, content, units);
      } else if (ext === ".txt") {
        extractLineBased(file, content, "fixture", units);
      }
    } catch {
      // Parse failure on a single file: skip it, keep the scan going.
    }
  }

  return units;
}

function isFixturePath(file: string): boolean {
  const parts = file.toLowerCase().split(/[\\/]/);
  return parts.includes("fixtures") || parts.includes("__fixtures__");
}

/** Collapse runs of whitespace/newlines so multi-line prose matches cleanly. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// JS / TS — comments + string literals
// ---------------------------------------------------------------------------

function extractJsTs(file: string, content: string, units: TextUnit[]): void {
  const ast = babelParse(content, {
    sourceType: "unambiguous",
    errorRecovery: true,
    plugins: ["typescript", "jsx"],
  });

  for (const comment of ast.comments ?? []) {
    const text = normalize(comment.value);
    if (text.length < 3) continue;
    units.push({
      file,
      line: comment.loc?.start.line ?? 1,
      source_kind: "comment",
      text,
    });
  }

  collectStringLiterals(ast.program, file, units);
}

/**
 * Walk the AST collecting string + template literals. We avoid a @babel/traverse
 * dependency (not in the locked deps) with a small recursive descent. Identifier-
 * like strings (no whitespace) are dropped so import paths and enum values don't
 * drown the prose; the addressee heuristic downstream needs sentences anyway.
 */
function collectStringLiterals(
  node: unknown,
  file: string,
  units: TextUnit[],
): void {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const child of node) collectStringLiterals(child, file, units);
    return;
  }

  const obj = node as Record<string, unknown> & {
    type?: string;
    loc?: { start?: { line?: number } };
  };
  const line = obj.loc?.start?.line ?? 1;

  if (obj.type === "StringLiteral" && typeof obj.value === "string") {
    pushLiteral(obj.value, file, line, units);
    return;
  }

  if (obj.type === "TemplateLiteral" && Array.isArray(obj.quasis)) {
    const raw = (obj.quasis as Array<{ value?: { cooked?: string; raw?: string } }>)
      .map((q) => q.value?.cooked ?? q.value?.raw ?? "")
      .join(" ");
    pushLiteral(raw, file, line, units);
    // fall through to also visit interpolated expressions
  }

  for (const key of Object.keys(obj)) {
    if (
      key === "loc" ||
      key === "start" ||
      key === "end" ||
      key === "range" ||
      key === "leadingComments" ||
      key === "trailingComments" ||
      key === "innerComments"
    ) {
      continue;
    }
    collectStringLiterals(obj[key], file, units);
  }
}

function pushLiteral(
  value: string,
  file: string,
  line: number,
  units: TextUnit[],
): void {
  const text = normalize(value);
  // Keep prose (has whitespace, reasonable length); drop identifiers/paths.
  if (text.length < 6 || !/\s/.test(text)) return;
  units.push({ file, line, source_kind: "string_literal", text });
}

// ---------------------------------------------------------------------------
// Python — # comments + triple-quoted docstrings
// ---------------------------------------------------------------------------

function extractPython(file: string, content: string, units: TextUnit[]): void {
  const lines = content.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const hash = raw.indexOf("#");
    if (hash === -1) return;
    // Skip shebangs and obvious URLs/fragments; keep everything else.
    if (i === 0 && raw.startsWith("#!")) return;
    const text = normalize(raw.slice(hash + 1));
    if (text.length < 3) return;
    units.push({ file, line: i + 1, source_kind: "comment", text });
  });

  const docstring = /("""|''')([\s\S]*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = docstring.exec(content)) !== null) {
    const text = normalize(m[2] ?? "");
    if (text.length < 3) continue;
    units.push({
      file,
      line: lineAtIndex(content, m.index),
      source_kind: "comment",
      text,
    });
  }
}

function lineAtIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Markdown / plain text / fixtures — one unit per non-empty line
// ---------------------------------------------------------------------------

function extractLineBased(
  file: string,
  content: string,
  kind: SourceKind,
  units: TextUnit[],
): void {
  const lines = content.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const text = normalize(raw);
    if (text.length < 1) return;
    units.push({ file, line: i + 1, source_kind: kind, text });
  });
}

// ---------------------------------------------------------------------------
// YAML / JSON — string scalars; a `description` key marks an MCP tool desc
// ---------------------------------------------------------------------------

function extractStructured(
  file: string,
  content: string,
  units: TextUnit[],
): void {
  const lineCounter = new LineCounter();
  // The yaml parser handles JSON too (JSON is a YAML subset), which gives us
  // line positions for JSON manifests that JSON.parse can't provide.
  //
  // Use parseAllDocuments (not parseDocument): a single `.yaml` can hold several
  // documents separated by `---` (k8s manifests, CI configs, multi-tool MCP/agent
  // config bundles). parseDocument returns only the FIRST, so an injection
  // payload in the 2nd+ document would be silently dropped. We scan every
  // document, skipping empty ones.
  const docs = parseAllDocuments(content, { lineCounter });

  for (const doc of docs) {
    if (doc.contents == null) continue;

    visit(doc, {
      Scalar(key, node, ancestors) {
        // Skip mapping keys themselves; keep mapping values and sequence items.
        if (key === "key") return;
        if (typeof node.value !== "string") return;

        const text = normalize(node.value);
        if (text.length < 4) return;

        const range = node.range;
        const line = range ? lineCounter.linePos(range[0]).line : 1;

        const source_kind: SourceKind = isDescriptionValue(ancestors)
          ? "mcp_tool_desc"
          : "yaml";

        units.push({ file, line, source_kind, text });
      },
    });
  }
}

/** True when the scalar is the value of a `description:` pair (MCP tool prose). */
function isDescriptionValue(ancestors: readonly unknown[]): boolean {
  const parent = ancestors[ancestors.length - 1];
  return (
    isPair(parent) &&
    isScalar(parent.key) &&
    parent.key.value === "description"
  );
}
