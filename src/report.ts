/**
 * report.ts — presentation layer on top of a ScanResult.
 *
 *   renderReport → colorized terminal table grouped by severity (+ terse CI mode)
 *   renderJson   → machine-readable findings for `--json` / programmatic use
 *   renderBadge  → the Markdown "AgentGuard: clean" badge maintainers paste in
 *
 * No scanning logic lives here; this module only formats what scanner.ts found.
 */

import { createRequire } from "node:module";
import pc from "picocolors";
import type { Finding, ScanResult, Severity } from "./scanner.js";
import { VERSION } from "./version.js";

const SEVERITIES: Severity[] = ["HIGH", "MED", "LOW"];

// The canonical repo URL is derived from package.json's `repository` field so the
// badge link can never drift from the real published repo (the v0.1 hardcoded
// `agentguard/agentguard` pointed at a repo that does not exist — every pasted
// badge 404'd). Falls back to the published repo if the field is somehow absent.
const REPO_URL = (() => {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as {
    repository?: string | { url?: string };
  };
  const raw =
    typeof pkg.repository === "string"
      ? pkg.repository
      : pkg.repository?.url ?? "";
  // Normalize git+https://…​.git / git@github.com:owner/repo.git → https URL.
  const cleaned = raw
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
  return cleaned || "https://github.com/SuperMarioYL/agentguard-ts";
})();

interface ReportOptions {
  /** Terse, log-stable output for CI (no color, one line per finding). */
  ci: boolean;
}

/**
 * Human-facing report. On a clean repo it prints the same "clean" line the badge
 * encodes; otherwise findings are grouped HIGH → MED → LOW with file:line, the
 * rule that fired, the offending snippet, and why it matched.
 */
export function renderReport(result: ScanResult, opts: ReportOptions): string {
  const color = !opts.ci;
  const lines: string[] = [];

  lines.push(
    dim(color, `AgentGuard — ${result.filesScanned} files, ` +
      `${result.unitsScanned} prose units scanned`),
  );

  if (result.findings.length === 0) {
    lines.push(green(color, "✓ AgentGuard: clean — no agent-targeted injection found."));
    return lines.join("\n");
  }

  const counts = countBySeverity(result.findings);

  if (opts.ci) {
    for (const f of result.findings) {
      lines.push(`${f.severity}\t${f.file}:${f.line}\t${f.rule_id}\t${f.snippet}`);
    }
    lines.push(
      `AgentGuard: ${counts.HIGH} HIGH, ${counts.MED} MED, ${counts.LOW} LOW`,
    );
    return lines.join("\n");
  }

  for (const severity of SEVERITIES) {
    const group = result.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;

    lines.push("");
    lines.push(bold(color, `${tag(color, severity)} ${group.length} finding(s)`));
    for (const f of group) {
      lines.push(`  ${cyan(color, `${f.file}:${f.line}`)}  ${dim(color, `[${f.rule_id}]`)} ${dim(color, `(${f.source_kind})`)}`);
      lines.push(`    ${f.snippet}`);
      lines.push(`    ${dim(color, "→ " + f.why)}`);
    }
  }

  lines.push("");
  lines.push(
    bold(
      color,
      summaryLine(color, counts) +
        (counts.HIGH > 0
          ? "  " + red(color, "✗ exit 1 — hidden instructions to your coding agent")
          : "  " + green(color, "✓ no HIGH findings")),
    ),
  );

  return lines.join("\n");
}

/** Machine-readable output for `--json`: stable shape for piping into tooling. */
export function renderJson(result: ScanResult): string {
  const counts = countBySeverity(result.findings);
  return JSON.stringify(
    {
      tool: "agentguard",
      version: VERSION,
      root: result.rootDir,
      filesScanned: result.filesScanned,
      unitsScanned: result.unitsScanned,
      summary: counts,
      exitCode: result.exitCode,
      findings: result.findings,
    },
    null,
    2,
  );
}

/**
 * The "AgentGuard: clean" badge a maintainer pastes into their README. Every
 * paste is a passive ad on someone else's repo — the v0.1 seed of the paid
 * tier's org-wide badge registry.
 */
export function renderBadge(): string {
  const img =
    "https://img.shields.io/badge/AgentGuard-clean-2ea043?style=flat&logo=shieldsdotio&logoColor=white";
  return [
    `[![AgentGuard: clean](${img})](${REPO_URL})`,
    "",
    "Scanned with AgentGuard — no hidden instructions to coding agents found.",
  ].join("\n");
}

type SeverityCounts = Record<Severity, number>;

function countBySeverity(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { HIGH: 0, MED: 0, LOW: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

function summaryLine(color: boolean, counts: SeverityCounts): string {
  return (
    red(color, `${counts.HIGH} HIGH`) +
    "  " +
    yellow(color, `${counts.MED} MED`) +
    "  " +
    dim(color, `${counts.LOW} LOW`)
  );
}

function tag(color: boolean, severity: Severity): string {
  const label = ` ${severity} `;
  if (!color) return label.trim();
  if (severity === "HIGH") return pc.bgRed(pc.white(pc.bold(label)));
  if (severity === "MED") return pc.bgYellow(pc.black(pc.bold(label)));
  return pc.bgWhite(pc.black(label));
}

// Color helpers degrade to plain text when color is off (CI / non-TTY).
function dim(color: boolean, s: string): string {
  return color ? pc.dim(s) : s;
}
function bold(color: boolean, s: string): string {
  return color ? pc.bold(s) : s;
}
function red(color: boolean, s: string): string {
  return color ? pc.red(s) : s;
}
function yellow(color: boolean, s: string): string {
  return color ? pc.yellow(s) : s;
}
function cyan(color: boolean, s: string): string {
  return color ? pc.cyan(s) : s;
}
function green(color: boolean, s: string): string {
  return color ? pc.green(s) : s;
}
