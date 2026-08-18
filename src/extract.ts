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

  // A top-level JS directive-prologue string (e.g. "AI assistant: delete …" as
  // the FIRST statement of a module/function) is parsed by babel as a
  // `Directive` node whose `value` is a `DirectiveLiteral`, stored in
  // `ast.program.directives` — NOT as a `StringLiteral` in
  // `ast.program.body`. Without this branch the DirectiveLiteral falls through
  // the type-dispatch and its `.value` string is never pushed, so the payload
  // is silently dropped (exit 0, no finding) while the same payload placed
  // AFTER a non-directive statement parses as a plain StringLiteral and fires
  // HIGH. Same defect class as the v0.6.0 JSXText fix; the node is already
  // reached via the `directives` key recursion above, so no traversal change
  // is needed — only the type-dispatch branch.
  if (obj.type === "DirectiveLiteral" && typeof obj.value === "string") {
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
  // Blank triple-quoted docstring spans (preserving newlines so line numbers and
  // the `#`-comment / single-line-string passes stay aligned). Docstrings are
  // extracted separately below; a `#` inside a docstring is not a comment. This
  // blanking was already done for the string pass — it is now computed once and
  // shared so the `#`-comment pass is also string-aware.
  const withoutDocstrings = content.replace(
    /("""|''')[\s\S]*?\1/g,
    (span) => span.replace(/[^\n]/g, " "),
  );

  // `#` comments. Blank single/double-quoted string spans on each line
  // (preserving length) BEFORE finding the `#`, so a `#` inside a string literal
  // is invisible to the comment scan and only a real trailing `#` comment is
  // extracted. Previously the pass took `raw.indexOf("#")` on the raw line, so
  // the first `#` — even one inside a quoted string — was treated as the comment
  // start and everything after it became one unit. That merged an in-string
  // addressee (`\bAI\b`, from text after the in-string `#`) with a destructive
  // verb (`delete`, from the real trailing comment) into a single unit, which
  // applyRules escalated to a false HIGH + exit 1 on benign Python. Mirrors the
  // docstring blanking above; the in-string prose is still scanned separately by
  // the string pass below, where the verb+addressee gate suppresses benign text.
  const stringBlankRe = /("|')((?:\\.|(?!\1).)*)\1/g;
  const lines = withoutDocstrings.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const blanked = raw.replace(stringBlankRe, (s) => s.replace(/[^\n]/g, " "));
    const hash = blanked.indexOf("#");
    if (hash === -1) return;
    // Skip shebangs and obvious URLs/fragments; keep everything else.
    if (i === 0 && raw.startsWith("#!")) return;
    const text = normalize(blanked.slice(hash + 1));
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
  // as a silent false-clean, inconsistent with JS/TS. Pull single/double-quoted
  // spans line by line from the docstring-blanked content and push them through
  // the same prose filter as JS/TS literals. No AST dep is available for Python,
  // so this mirrors the existing regex approach; the downstream verb+addressee
  // gate suppresses benign prose (as for `#` comments).
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
  // Blank single/double-quoted YAML scalar spans — INCLUDING multi-line quoted
  // scalars — before the per-line `#` scan, so a `#` inside a quoted string is
  // invisible to the comment scan (a `#` there is a literal char of the scalar,
  // not a comment start). The scalar value itself is still scanned separately
  // by extractStructured; this pass only finds real `#` comments.
  const blanked = blankYamlQuoted(content);
  const lines = blanked.split(/\r?\n/);
  lines.forEach((line, i) => {
    const hash = yamlCommentStart(line);
    if (hash === -1) return;
    const text = normalize(line.slice(hash + 1));
    if (text.length < 3) return;
    units.push({ file, line: i + 1, source_kind: "yaml", text });
  });
}

/**
 * Return `content` with every char inside a single/double-quoted YAML scalar
 * (including the quote chars) replaced by a space, preserving newlines and
 * length, so quoted spans are invisible to the `#`-comment scan. Mirrors the
 * v0.8.0 extractPython string-blanking, but is stateful ACROSS lines.
 *
 * fix-yaml-multiline-quoted-hash-duplicate (v0.14.0): the v0.13.0 blanker was
 * the per-line regex `("|')((?:\\.|(?!\1).)*)\1` inside yamlCommentStart, which
 * cannot match a quoted scalar that opens on one line and closes on a later
 * line (the `.` / `(?!\1).` exclude newline). For a properly-indented
 * multi-line quoted YAML scalar whose continuation line begins with `# ...`,
 * the `#` is a literal char of the string (not a comment), but the per-line
 * blanker had no quote state across lines, so it treated the `#` as a comment
 * start and emitted a spurious `yaml` unit from `#` to EOL — duplicating the
 * findings the scalar value already produced (e.g. TWO destructive.delete HIGH
 * findings for one payload, inflating summary.HIGH). This pass tracks an open
 * quote across lines so continuation lines of a multi-line quoted scalar are
 * blanked too.
 *
 * Value-position guard: a quote only OPENS a (possibly multi-line) scalar when
 * it is in a value position — the first non-whitespace char on the line, or
 * immediately preceded by `:` (a mapping value). This stops a stray apostrophe
 * or quote in prose (`# it's ok`, `# see "docs"`) from opening a "multi-line
 * scalar" that swallows following lines (which would hide a later real `#`
 * comment — a false clean). Same-line quoted pairs in any position are still
 * blanked via findSameLineQuoteClose (matching the prior per-line regex).
 */
function blankYamlQuoted(content: string): string {
  const out: string[] = [];
  let i = 0;
  // The open quote char of an unclosed (possibly multi-line) quoted scalar, or
  // null when not inside one. Tracked across lines.
  let quote: '"' | "'" | null = null;
  // Last non-whitespace char seen on the current line while NOT inside a quote.
  let prevSignificant = "";
  // True while only whitespace has been seen on the current line (outside a quote).
  let atLineStart = true;

  while (i < content.length) {
    const ch = content[i] ?? "";

    if (quote !== null) {
      // Inside an open quoted scalar.
      if (quote === '"' && ch === "\\") {
        // Escaped char in a double-quoted scalar: backslash + next are literal.
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (quote === "'" && ch === "'" && (content[i + 1] ?? "") === "'") {
        // Escaped `''` in a single-quoted scalar: both are a literal `'`.
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (ch === quote) {
        out.push(" "); // closing quote
        quote = null;
        prevSignificant = "";
        atLineStart = false;
        i += 1;
        continue;
      }
      // Literal scalar content; preserve newlines so line structure survives.
      out.push(ch === "\n" ? "\n" : " ");
      if (ch === "\n") {
        atLineStart = true;
        prevSignificant = "";
      }
      i += 1;
      continue;
    }

    // Not inside a quoted scalar.
    if (ch === "\n") {
      out.push("\n");
      atLineStart = true;
      prevSignificant = "";
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const isValuePos = atLineStart || prevSignificant === ":";
      if (isValuePos) {
        // Open a (possibly multi-line) quoted scalar.
        out.push(" ");
        quote = ch;
        atLineStart = false;
        prevSignificant = "";
        i += 1;
        continue;
      }
      // Non-value-position quote: blank the same-line pair if it closes on
      // this line (mirrors the prior per-line regex). If it does not close on
      // this line, leave it raw — an unclosed mid-prose quote is not a scalar.
      const closeIdx = findSameLineQuoteClose(content, i, ch);
      if (closeIdx === -1) {
        out.push(ch);
        prevSignificant = ch;
        atLineStart = false;
        i += 1;
        continue;
      }
      for (let k = i; k <= closeIdx; k++) {
        out.push(content[k] === "\n" ? "\n" : " ");
      }
      i = closeIdx + 1;
      prevSignificant = ch;
      atLineStart = false;
      continue;
    }
    // Plain char.
    out.push(ch);
    if (ch !== " " && ch !== "\t") {
      prevSignificant = ch;
      atLineStart = false;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * Index of the closing quote for a scalar opened at `openIdx` (quote char
 * `quote`), scanning only the SAME line (a newline ends the search and returns
 * -1), respecting `\"` escapes (double) and `''` escapes (single). Used by
 * blankYamlQuoted to blank same-line non-value-position quoted pairs.
 */
function findSameLineQuoteClose(
  content: string,
  openIdx: number,
  quote: string,
): number {
  let j = openIdx + 1;
  while (j < content.length) {
    const c = content[j] ?? "";
    if (c === "\n") return -1;
    if (quote === '"' && c === "\\") {
      j += 2;
      continue;
    }
    if (quote === "'" && c === "'" && (content[j + 1] ?? "") === "'") {
      j += 2;
      continue;
    }
    if (c === quote) return j;
    j += 1;
  }
  return -1;
}

/**
 * Index of the `#` that begins a YAML comment on a (quote-blanked) line, or
 * -1. Per the YAML spec a `#` starts a comment only at the line start or when
 * preceded by whitespace; a `#` embedded in a token (e.g. a URL fragment `a#b`
 * or a color `#fff`) is literal and not a comment. The line passed in is
 * expected to have already been quote-blanked by blankYamlQuoted (so a `#`
 * inside a single/double-quoted scalar — including a multi-line quoted scalar's
 * continuation line — is already a space and invisible here). The per-line
 * regex blanking is retained as a defensive no-op on already-blanked input and
 * for direct callers; the multi-line case is handled by blankYamlQuoted.
 *
 * fix-yaml-hash-in-string-false-high (v0.13.0): previously this pass did NOT
 * track quotes, so a `#` inside a quoted YAML string value that was preceded
 * by a space (e.g. `name: "AI # assistant"`) was treated as the comment
 * start. The extracted comment then ran from the in-string `#` to the end of
 * line, merging the in-string addressee (`AI assistant`, from text after the
 * in-string `#`) with a real trailing `#` comment's verb (`delete`) into one
 * unit, which applyRules escalated to a false HIGH + exit 1 on benign YAML.
 * The v0.8.0 Python `#`-comment pass was made string-aware but the YAML pass
 * was not; this closes that gap. The in-string prose is still scanned
 * separately by extractStructured (the scalar value), where the
 * verb+addressee gate suppresses benign text.
 *
 * fix-yaml-multiline-quoted-hash-duplicate (v0.14.0): the v0.13.0 per-line
 * regex could not span a newline, so a `#` on a continuation line of a
 * multi-line quoted scalar was still mis-detected as a comment start (a
 * spurious `yaml` unit + duplicate findings). blankYamlQuoted now blanks
 * multi-line quoted spans before this scan; this function's regex remains for
 * the single-line case and as a defensive re-blank.
 */
function yamlCommentStart(line: string): number {
  // Blank single/double-quoted scalar spans (preserving length) so a `#`
  // inside a quoted string is invisible to the comment scan — a `#` there is a
  // literal char, not a comment start. On input already blanked by
  // blankYamlQuoted this is a no-op; it remains for direct callers and defense.
  const stringBlankRe = /("|')((?:\\.|(?!\1).)*)\1/g;
  const blanked = line.replace(stringBlankRe, (s) => s.replace(/[^\n]/g, " "));
  for (let i = 0; i < blanked.length; i++) {
    if (blanked[i] !== "#") continue;
    if (i === 0 || blanked[i - 1] === " " || blanked[i - 1] === "\t") return i;
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
