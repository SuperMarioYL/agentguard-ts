/**
 * rules.ts — load the signature corpus and classify extracted prose.
 *
 * The corpus (rules/injection-signatures.yaml) is the cross-product the analysis
 * calls the product's moat: an imperative *verb* aimed at an assistant
 * (delete / curl / exfiltrate / ignore previous instructions) AND an *addressee*
 * heuristic — text that talks to "the AI / assistant / agent / model" rather
 * than to a human.
 *
 * Precision is a kill criterion (a scanner that floods CI with false positives
 * gets uninstalled), so the addressee heuristic gates severity: a destructive
 * verb that is *not* addressed to an agent ("delete node_modules and retry") is
 * downgraded a level rather than reported as a HIGH attack.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Finding, Rule, Severity, TextUnit } from "./scanner.js";

/** rules/ sits at the package root; both src/ and dist/ are one level under it. */
const DEFAULT_RULES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "rules",
  "injection-signatures.yaml",
);

/** Trim a matched unit down to a readable one-line snippet for the report. */
const SNIPPET_MAX = 160;

interface RulesFile {
  version?: number;
  /** Global addressee patterns applied to any rule without its own list. */
  addressees?: string[];
  rules?: Array<{
    id?: string;
    severity?: string;
    verbs?: string[];
    addressees?: string[];
    description?: string;
  }>;
}

/**
 * Read and validate the YAML signature corpus. Each rule inherits the file's
 * global `addressees` unless it declares its own, so the addressee heuristic is
 * authored once and reused everywhere.
 */
export async function loadRules(rulesPath?: string): Promise<Rule[]> {
  const file = rulesPath ?? DEFAULT_RULES_PATH;

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read rules file at ${file}: ${why}`);
  }

  const doc = parseYaml(raw) as RulesFile | null;
  if (!doc || !Array.isArray(doc.rules)) {
    throw new Error(`rules file ${file} has no "rules:" list`);
  }

  const globalAddressees = Array.isArray(doc.addressees) ? doc.addressees : [];

  const rules: Rule[] = [];
  for (const entry of doc.rules) {
    if (!entry || typeof entry.id !== "string") continue;
    const severity = normalizeSeverity(entry.severity);
    if (!severity) continue;
    const verbs = (entry.verbs ?? []).filter((v) => typeof v === "string");
    if (verbs.length === 0) continue;

    const addressees =
      Array.isArray(entry.addressees) && entry.addressees.length > 0
        ? entry.addressees
        : globalAddressees;

    rules.push({
      id: entry.id,
      severity,
      verbs,
      addressees,
      description: entry.description ?? entry.id,
    });
  }

  if (rules.length === 0) {
    throw new Error(`rules file ${file} produced no usable rules`);
  }
  return rules;
}

interface CompiledRule {
  rule: Rule;
  verbRes: RegExp[];
  addrRes: RegExp[];
}

/**
 * Classify every extracted unit against the ruleset, returning ranked findings.
 *
 * For each (unit, rule): a finding is emitted only if one of the rule's verbs
 * matches. If an addressee pattern also matches, the finding fires at the rule's
 * full severity; otherwise it is downgraded one level (and dropped if that would
 * fall below LOW). This is the heuristic that keeps benign instructional prose
 * out of the HIGH bucket.
 */
export function applyRules(units: TextUnit[], rules: Rule[]): Finding[] {
  const compiled = rules.map(compile);
  const findings: Finding[] = [];

  for (const unit of units) {
    for (const c of compiled) {
      const verbHit = firstMatch(c.verbRes, unit.text);
      if (!verbHit) continue;

      const addrHit = firstMatch(c.addrRes, unit.text);
      const severity = addrHit
        ? c.rule.severity
        : downgrade(c.rule.severity);
      if (!severity) continue;

      findings.push({
        file: unit.file,
        line: unit.line,
        source_kind: unit.source_kind,
        rule_id: c.rule.id,
        severity,
        snippet: toSnippet(unit.text),
        why: addrHit
          ? `"${verbHit}" addressed to an agent ("${addrHit}") — ${c.rule.description}`
          : `"${verbHit}" matched but no explicit agent addressee — downgraded`,
      });
    }
  }

  return rank(findings);
}

function compile(rule: Rule): CompiledRule {
  return {
    rule,
    verbRes: rule.verbs.map(safeRegex).filter(isRegExp),
    addrRes: (rule.addressees ?? []).map(safeRegex).filter(isRegExp),
  };
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function isRegExp(re: RegExp | null): re is RegExp {
  return re !== null;
}

/** Return the literal text matched by the first matching pattern, or null. */
function firstMatch(res: RegExp[], text: string): string | null {
  for (const re of res) {
    const m = re.exec(text);
    if (m) return m[0] ?? null;
  }
  return null;
}

const SEVERITY_ORDER: Record<Severity, number> = { HIGH: 0, MED: 1, LOW: 2 };

/** One step down the severity ladder; null means "drop the finding". */
function downgrade(severity: Severity): Severity | null {
  if (severity === "HIGH") return "MED";
  if (severity === "MED") return "LOW";
  return null;
}

function normalizeSeverity(value: unknown): Severity | null {
  const v = String(value ?? "").toUpperCase();
  if (v === "HIGH" || v === "MED" || v === "LOW") return v;
  return null;
}

function toSnippet(text: string): string {
  return text.length > SNIPPET_MAX
    ? text.slice(0, SNIPPET_MAX - 1) + "…"
    : text;
}

/** HIGH before MED before LOW; then by file path, then line. */
function rank(findings: Finding[]): Finding[] {
  return findings.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
}
