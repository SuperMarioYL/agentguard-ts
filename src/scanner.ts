/**
 * scanner.ts — orchestrator.
 *
 * Owns the shared data model (the AgentThreat `Finding` primitive) and the
 * single entry point `scan()`. The pipeline is walk → extract → rules, with
 * `report.ts` handling presentation on top of the returned `ScanResult`.
 *
 * walk / extract / rules are filled in by later build stages; this module only
 * declares the boundaries they implement against.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { walk } from "./walk.js";
import { extract } from "./extract.js";
import { loadRules, applyRules } from "./rules.js";

export type Severity = "HIGH" | "MED" | "LOW";

export type SourceKind =
  | "comment"
  | "markdown"
  | "yaml"
  | "mcp_tool_desc"
  | "fixture"
  | "string_literal";

/** A unit of natural-language prose extracted from a file, pre-classification. */
export interface TextUnit {
  /** Path within the project or its dependency tree. */
  file: string;
  /** 1-based line number where the unit begins. */
  line: number;
  source_kind: SourceKind;
  /** The normalized prose itself. */
  text: string;
}

/**
 * The core primitive: prose classified as adversarial-to-an-LLM-agent.
 * SAST emits "vulnerable code"; AgentGuard emits "hostile instruction aimed at
 * the agent reading this repo."
 */
export interface Finding {
  file: string;
  line: number;
  source_kind: SourceKind;
  /** e.g. "destructive.delete", "exfil.network", "phish.credential". */
  rule_id: string;
  severity: Severity;
  snippet: string;
  /** Human-readable explanation of which trigger fired. */
  why: string;
}

/** A signature loaded from rules/injection-signatures.yaml. */
export interface Rule {
  id: string;
  severity: Severity;
  /** Imperative verbs aimed at an assistant (delete / curl / exfiltrate / ...). */
  verbs: string[];
  /**
   * Corroborated patterns (hostile verb + noun, e.g. "read the .env") that are
   * self-evidently adversarial and therefore fire without needing an explicit
   * agent addressee. Unlike bare-noun `verbs`, these are NOT suppressed even when
   * the rule sets `requireAddressee`.
   */
  strongVerbs?: string[];
  /** Addressee heuristic: phrases that talk *to* the agent ("AI", "assistant"). */
  addressees?: string[];
  /**
   * When true, bare-noun `verbs` must be accompanied by an agent addressee to
   * produce a finding at all (the match is dropped, not downgraded). This stops
   * benign developer prose ("store your api key in the vault") from flooding the
   * report with low-value findings. `strongVerbs` are exempt.
   */
  requireAddressee?: boolean;
  description: string;
}

export interface ScanOptions {
  /** Emit machine-readable JSON instead of the terminal table. */
  json?: boolean;
  /** CI mode: terse summary, stable for log capture. */
  ci?: boolean;
  /** Override the bundled rules/injection-signatures.yaml. */
  rulesPath?: string;
  /** Also walk node_modules / declared dependencies (default true). */
  includeDeps?: boolean;
  /**
   * Explicit path to a per-project `.agentguard.yaml` config. When unset, the
   * scan auto-discovers `.agentguard.yaml` / `.agentguard.yml` at the scan
   * root. An absent/empty config means "use the bundled defaults" (no behavior
   * change).
   */
  configPath?: string;
}

export interface ScanResult {
  rootDir: string;
  filesScanned: number;
  unitsScanned: number;
  findings: Finding[];
  /** Non-zero when any HIGH finding exists, so the CLI drops into CI cleanly. */
  exitCode: number;
}

/**
 * Per-project rule overrides (m5_project_config). A `.agentguard.yaml` at the
 * scan root lets a team scope rule enablement and severity to their monorepo
 * WITHOUT forking the bundled `rules/injection-signatures.yaml` — disabling a
 * noisy rule by id or overriding a rule's severity. An absent or empty config
 * means "use the bundled defaults" (no behavior change), so existing scans are
 * unaffected. A malformed config is ignored (the safe direction: the bundled
 * defaults fire, never a silent disable).
 */
export interface ProjectConfig {
  /** Rule ids to drop entirely (no findings from these rules). */
  disableRules: Set<string>;
  /** Per-rule severity overrides (rule id → severity). */
  severityOverrides: Map<string, Severity>;
}

const CONFIG_FILENAMES = [".agentguard.yaml", ".agentguard.yml"];

/** Read the project config from `rootDir` (or an explicit path), or null. */
async function loadProjectConfig(
  rootDir: string,
  configPath?: string,
): Promise<ProjectConfig | null> {
  const candidates =
    configPath !== undefined ? [configPath] : CONFIG_FILENAMES.map((n) => path.join(rootDir, n));
  for (const file of candidates) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    return parseProjectConfig(raw);
  }
  return null;
}

function parseProjectConfig(raw: string): ProjectConfig {
  const disableRules = new Set<string>();
  const severityOverrides = new Map<string, Severity>();
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    // Malformed YAML: ignore the config (bundled defaults fire — safe).
    return { disableRules, severityOverrides };
  }
  if (!parsed || typeof parsed !== "object") {
    return { disableRules, severityOverrides };
  }
  const doc = parsed as { disable_rules?: unknown; severity_overrides?: unknown };
  if (Array.isArray(doc.disable_rules)) {
    for (const id of doc.disable_rules) {
      if (typeof id === "string" && id.length > 0) disableRules.add(id);
    }
  }
  if (doc.severity_overrides && typeof doc.severity_overrides === "object") {
    for (const [id, sev] of Object.entries(
      doc.severity_overrides as Record<string, unknown>,
    )) {
      const s = normalizeSeverityOverride(sev);
      if (s) severityOverrides.set(id, s);
    }
  }
  return { disableRules, severityOverrides };
}

function normalizeSeverityOverride(value: unknown): Severity | null {
  const v = String(value ?? "").toUpperCase();
  if (v === "HIGH" || v === "MED" || v === "LOW") return v;
  return null;
}

/** Drop disabled rules and apply severity overrides to the rest. */
function applyProjectConfig(rules: Rule[], config: ProjectConfig | null): Rule[] {
  if (!config) return rules;
  if (config.disableRules.size === 0 && config.severityOverrides.size === 0) {
    return rules;
  }
  const out: Rule[] = [];
  for (const rule of rules) {
    if (config.disableRules.has(rule.id)) continue;
    const override = config.severityOverrides.get(rule.id);
    out.push(override ? { ...rule, severity: override } : rule);
  }
  return out;
}

/**
 * Walk a project (and, by default, its dependency tree), extract natural-language
 * prose, classify it against the signature ruleset, and return ranked findings.
 */
export async function scan(
  rootDir: string,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const files = await walk(rootDir, { includeDeps: opts.includeDeps ?? true });
  const units = await extract(files);
  const rules = await loadRules(opts.rulesPath);
  const config = await loadProjectConfig(rootDir, opts.configPath);
  const effectiveRules = applyProjectConfig(rules, config);
  const findings = applyRules(units, effectiveRules);

  const exitCode = findings.some((f) => f.severity === "HIGH") ? 1 : 0;

  return {
    rootDir,
    filesScanned: files.length,
    unitsScanned: units.length,
    findings,
    exitCode,
  };
}
