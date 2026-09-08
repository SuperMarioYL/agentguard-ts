[简体中文](./README.md) · [Website](https://agentguard-ts.lei6393.com) · [GitHub](https://github.com/SuperMarioYL/agentguard-ts)

<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="./assets/presentation/hero-mobile-dark.svg">
  <source media="(max-width: 600px)" srcset="./assets/presentation/hero-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="./assets/presentation/hero-dark.svg">
  <img src="./assets/presentation/hero-light.svg" width="960" alt="Hero diagram">
</picture>

# agentguard-ts

**Find suspicious instructions in the files agents read.**

AgentGuard scans local project and dependency text, extracts prose units and applies explicit instruction-pattern rules.

## Why use it

Comments, documentation and fixtures can contain text addressed to an assistant. A scan that keeps source type and location gives a reviewer a concrete sentence to inspect.

- **Locate exact prose** — Findings preserve source file and line.
- **Inspect why it matched** — Rule explanations expose the trigger phrase.
- **Control CI behavior** — Severity and configured rules determine exit status.

## Architecture

<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="./assets/presentation/architecture-mobile-dark.svg">
  <source media="(max-width: 600px)" srcset="./assets/presentation/architecture-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="./assets/presentation/architecture-dark.svg">
  <img src="./assets/presentation/architecture-light.svg" width="960" alt="Architecture diagram">
</picture>

walk enumerates files, extract reads comments, Markdown, YAML and supported tool-description text, and rules combines suspicious verbs with addressee patterns. scanner applies project overrides and report groups findings by severity. HIGH findings set a nonzero scan status.

| Component | Responsibility |
| --- | --- |
| `File walk` | src/walk.ts |
| `Prose extraction` | src/extract.ts |
| `Pattern rules` | src/rules.ts |
| `Findings / report` | src/scanner.ts; report.ts |

## Install and quickstart

Build with the version declared in the repository manifest. Run the example from the repository root.

```bash
git clone https://github.com/SuperMarioYL/agentguard-ts.git
cd agentguard-ts
npm ci
npm run build
```

Create a temporary complete README with one suspicious sentence and ordinary documentation, then run the production scan pipeline.

```bash
node examples/presentation-demo.mjs
```

## Recorded demo

<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="./assets/presentation/process-mobile-dark.svg">
  <source media="(max-width: 600px)" srcset="./assets/presentation/process-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="./assets/presentation/process-dark.svg">
  <img src="./assets/presentation/process-light.svg" width="960" alt="Process diagram">
</picture>

The scanner reports a HIGH destructive.delete finding at the synthetic README’s second line.

```text
{
  "files": 1,
  "units": 3,
  "findings": [
    {
      "file": "README.md",
      "line": 2,
      "rule": "destructive.delete",
      "severity": "HIGH"
    }
  ],
  "scan_exit": 1
}
```

The complete command and output are recorded in [docs/demo-results.json](./docs/demo-results.json). Inputs and reproduction code are included in the repository.

![Existing terminal recording](./assets/demo.gif)

The existing recording is retained for context; the text example above documents the reproducible scenario.

## Usage

The CLI exposes the following operations. Commands after the example use your own paths or identifiers.

```bash
node dist/cli.js scan . --no-deps
node dist/cli.js scan . --json
node dist/cli.js scan . --ci
```

## Configuration

The CLI defaults to scanning project files and dependencies; --no-deps excludes dependencies. .agentguard.yaml can disable rules or override severities. An explicit --config path must be readable and valid; --rules selects another signature file.

## Integrations and responsibilities

<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="./assets/presentation/integrations-mobile-dark.svg">
  <source media="(max-width: 600px)" srcset="./assets/presentation/integrations-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="./assets/presentation/integrations-dark.svg">
  <img src="./assets/presentation/integrations-light.svg" width="960" alt="Integrations diagram">
</picture>

The following routes are implemented in the source. Choose the input that matches your task and keep the resulting artifact with your project.

| Route | Implemented role |
| --- | --- |
| Local source / node_modules | File scan input |
| Typed prose units | Comments, Markdown and YAML |
| Rule YAML | Instruction signatures |
| Project config | Rule disable and severity overrides |

## Limits and next steps

- This is heuristic text detection, not proof that a package is malicious or that a clean package is safe.
- Changing rule severity can change the CI result. Inspect project overrides when interpreting a clean status.
- The demo scans one synthetic README and never executes its suspicious sentence.

Additional language extraction and rule precision should be driven by concrete missed payloads and benign-text false positives.

## License and contributions

See [LICENSE](./LICENSE). When reporting an issue, include a minimal input, the command, and the observed output.
