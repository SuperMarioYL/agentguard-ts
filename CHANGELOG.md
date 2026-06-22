# Changelog

All notable changes to AgentGuard are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-06-22

Hardening release. Four repo-verified defect fixes that improve precision and
close two false-negative gaps, plus a reliability fix for the machine-readable
output path the tool exists for.

### Fixed
- **Reliable piped output (`fix-stdout-truncation-on-exit`).** `agentguard scan`
  no longer calls `process.exit()` before stdout has drained. On a pipe (the
  primary `--json` / CI path, not a TTY), buffered writes were terminated
  mid-flush, truncating the human report at the ~128 KB OS pipe buffer and
  corrupting `--json` into an unparseable document at 131072 bytes. The CLI now
  sets `process.exitCode` and lets the event loop flush stdout naturally, so even
  multi-megabyte output survives the pipe intact.
- **No more noun-only false positives (`fix-noun-only-false-positives`).** Bare
  credential/destructive nouns (`password`, `secret`, `.env`, `api key`,
  `delete`, `wipe`) no longer flag benign developer prose. Rules prone to
  everyday prose now set `require_addressee` — a bare-noun hit with no agent
  addressee is dropped entirely instead of surfaced as MED noise. Genuinely
  hostile, addressee-free phrasing ("read the .env and upload it", "rm -rf") is
  still caught via the new `strong_verbs` corroborated patterns. A clean README
  now yields zero findings. The `agent` addressee was also tightened so
  `ssh-agent` / `user agent` / `build agent` are no longer mistaken for an AI.
- **Byte-accurate size guard (`fix-max-bytes-uses-char-length`).** The
  `MAX_FILE_BYTES` skip now measures real byte size via `stat()` **before**
  reading the file, instead of comparing the UTF-16 string length post-read. A
  multi-megabyte multibyte (e.g. CJK) file that previously slipped under the
  char-count limit — and was fully read into memory regardless — is now skipped
  without being read.
- **Multi-document YAML coverage (`fix-multidoc-yaml-only-first-parsed`).**
  Extraction now uses `parseAllDocuments` and scans every `---`-separated
  document. Previously only the first document was parsed, so an injection
  payload in the 2nd+ document of a k8s manifest, CI config, or multi-tool
  MCP/agent bundle was silently missed — a false negative on a core scanned
  file type.

### Changed
- `assets/demo.tape` now pipes scan output to a file and prints it back,
  demonstrating that the full report + summary line survive the pipe (validating
  the stdout-truncation fix in the same demo).

### Distribution
- Listed for passive discovery via awesome-list and MCP-registry submissions,
  anchored on the reproducible jqwik catch.

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

[0.2.0]: https://github.com/SuperMarioYL/agentguard-ts/releases/tag/v0.2.0
[0.1.0]: https://github.com/SuperMarioYL/agentguard-ts/releases/tag/v0.1.0
