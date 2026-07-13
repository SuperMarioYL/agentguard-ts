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
        // The structured parser discards `#` comments, so a payload hidden in a
        // YAML comment scanned as a silent false-clean. Scan them line-based
        // (YAML only — JSON has no `#` comment syntax).
        if (ext === ".yaml" || ext === ".yml") {
          extractYamlComments(file, content, units);
        }
      } else if (ext === ".txt") {
        extractLineBased(file, content, "fixture", units);
      } else if (isFixturePath(file)) {
        // Fallback ONLY for files with no recognized extension living under a
        // fixtures dir — genuinely raw payload data. A real .ts/.yaml/.md/.py
        // under a user's own test/fixtures/ tree is extracted by its real
        // extension above (correct source_kind + AST), instead of being
        // blanket line-based mis-parsed just because the path contains
        // "fixtures".
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
  let ast: ReturnType<typeof babelParse>;
  try {
    ast = babelParse(content, {
      sourceType: "unambiguous",
      errorRecovery: true,
      // `decorators-legacy` is required or babel THROWS (not error-recovers) on
      // any decorator (@Component, @Injectable, @Entity — Angular / NestJS /
      // TypeORM / MobX / class-validator, all common in real deps). Without it
      // the throw propagated to extract()'s blanket catch and the ENTIRE file
      // was silently skipped, scanning a decorator-using source as false-clean.
      plugins: ["typescript", "jsx", "decorators-legacy"],
    });
  } catch {
    // A total parse failure (syntax babel cannot even error-recover from) must
    // NOT make the whole file a silent "clean". Fall back to line-based prose
    // extraction so an agent-directed payload is still surfaced.
    extractLineBased(file, content, "comment", units);
    return;
  }

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

  // JSX element text (`<div>Dear coding agent: ...</div>`) is a JSXText node —
  // neither a StringLiteral nor a TemplateLiteral — so without this branch a
  // payload written as visible JSX text was never extracted and scanned as a
  // silent false-clean. JSX/TSX is pervasive in the React deps we walk, making
  // JSX text a real supply-chain injection vector. It has no child prose nodes
  // worth recursing into, so classify and return.
  if (obj.type === "JSXText" && typeof obj.value === "string") {
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

  // Single-line string literals. The JS/TS extractor collects string-literal
  // prose (an agent-readable supply-chain injection vector), but the Python
  // path previously extracted only `#` comments + triple-quoted docstrings — so
  // an identical payload placed in an ordinary Python string constant (e.g. a
  // module-level `PROMPT = "…"` or an MCP tool `description="…"` kwarg) scanned
  // as a silent false-clean, inconsistent with JS/TS. Blank out the already-
  // extracted triple-quoted spans first (preserving newlines so line numbers are
  // unchanged), then pull single/double-quoted spans line by line and push them
  // through the same prose filter as JS/TS literals. No AST dep is available for
  // Python, so this mirrors the existing regex approach; the downstream
  // verb+addressee gate suppresses benign prose (as for `#` comments).
  const withoutDocstrings = content.replace(
    /("""|''')[\s\S]*?\1/g,
    (span) => span.replace(/[^\n]/g, " "),
  );
  const stringRe = /("|')((?:\\.|(?!\1).)*)\1/g;
  withoutDocstrings.split(/\r?\n/).forEach((raw, i) => {
    let sm: RegExpExecArray | null;
    stringRe.lastIndex = 0;
    while ((sm = stringRe.exec(raw)) !== null) {
      pushLiteral(sm[2] ?? "", file, i + 1, units);
    }
  });
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
        if (typeof node.value !== "string") return;

        const text = normalize(node.value);
        if (text.length < 4) return;

        const range = node.range;
        const line = range ? lineCounter.linePos(range[0]).line : 1;

        // Mapping KEYS are attacker-controllable in exactly the manifests we
        // target (MCP tool `name:`/config keys, arbitrary object keys an agent
        // reads), so scan their prose too — previously the `key === "key"`
        // early-return let a payload placed in a key scan as clean. A key is
        // never a description value, so tag it plain "yaml".
        if (key === "key") {
          units.push({ file, line, source_kind: "yaml", text });
          return;
        }

        const source_kind: SourceKind = isDescriptionValue(ancestors)
          ? "mcp_tool_desc"
          : "yaml";

        units.push({ file, line, source_kind, text });
      },
    });
  }
}

/**
 * Extract prose from YAML `#` comments. The `yaml` parser discards comments, so
 * a payload hidden in a comment of a YAML manifest / CI / MCP config — exactly
 * the files this tool targets, and prose an agent reading the file ingests — was
 * never seen by extractStructured and scanned as a silent false-clean. This
 * mirrors the Python `#`-comment extraction (extractPython). JSON has no `#`
 * comment syntax, so callers restrict this to `.yaml`/`.yml`.
 */
function extractYamlComments(
  file: string,
  content: string,
  units: TextUnit[],
): void {
  const lines = content.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const hash = yamlCommentStart(raw);
    if (hash === -1) return;
    const text = normalize(raw.slice(hash + 1));
    if (text.length < 3) return;
    units.push({ file, line: i + 1, source_kind: "yaml", text });
  });
}

/**
 * Index of the `#` that begins a YAML comment on a line, or -1. Per the YAML
 * spec a `#` starts a comment only at the line start or when preceded by
 * whitespace; a `#` embedded in a token (e.g. a URL fragment `a#b` or a
 * color `#fff`) is literal and not a comment. This is a lightweight,
 * intentionally over-inclusive heuristic (it does not track quotes) — a `#`
 * inside a quoted scalar that is preceded by a space may be re-scanned as a
 * comment, but that scalar is already scanned separately, so the effect is a
 * harmless duplicate rather than a miss; the downstream verb+addressee gate
 * suppresses benign prose.
 */
function yamlCommentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "#") continue;
    if (i === 0 || line[i - 1] === " " || line[i - 1] === "\t") return i;
  }
  return -1;
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
