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
  const findings = applyRules(units, rules);

  const exitCode = findings.some((f) => f.severity === "HIGH") ? 1 : 0;

  return {
    rootDir,
    filesScanned: files.length,
    unitsScanned: units.length,
    findings,
    exitCode,
  };
}
