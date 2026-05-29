# Changelog

All notable changes to AgentGuard are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-30

First public release. A local-only CLI that scans a project and its dependency
tree for natural-language instructions aimed at a coding agent.

### Added — `m1_walk_extract`
- `walk.ts` enumerates scannable files across the project and `node_modules`,
  skipping lockfiles, minified bundles, and binaries (`fast-glob`).
- `extract.ts` normalizes prose into `TextUnit`s: JS/TS comments + prose string
  literals (`@babel/parser`), Python `#` comments + docstrings, Markdown body
  lines, YAML/JSON scalars (with `description:` tagged as `mcp_tool_desc`), and
  fixture/text lines.

### Added — `m2_classify_report`
- `rules/injection-signatures.yaml` signature corpus: seven rule families
  (`destructive.delete`, `exfil.network`, `phish.credential`,
  `injection.override`, `privilege.escalate`, `persistence.backdoor`,
  `obfuscation.hidden`).
- `rules.ts` classifies units via a verb × addressee heuristic — a destructive
  verb addressed to an agent fires at full severity; the same verb with no agent
  addressee is downgraded one level to keep benign developer prose out of HIGH.
- `report.ts` renders a colorized report grouped HIGH → MED → LOW, each finding
  carrying `file:line`, `rule_id`, source kind, snippet, and a `why` line.
- Non-zero exit code whenever a HIGH finding exists, so the scanner drops into
  CI and pre-commit with no extra wiring.

### Added — `m3_badge_ci`
- `--json` machine-readable output and `--ci` terse, ANSI-free output modes.
- `agentguard badge` prints a paste-ready "AgentGuard: clean" Markdown badge.
- `test/fixtures/jqwik-payload.txt` reproduces the real public May 2026 jqwik
  injection payload; the test suite asserts it is caught as three HIGH findings
  end to end.

[0.1.0]: https://github.com/agentguard/agentguard/releases/tag/v0.1.0
