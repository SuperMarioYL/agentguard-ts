# AgentGuard demo — rendered to assets/demo.gif by vhs (.github/workflows/demo.yml)
Output assets/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1100
Set Height 660
Set Theme "Catppuccin Mocha"
Set Padding 20

Type "agentguard --version"
Enter
Sleep 1200ms

# The v0.3.0 headline: a .cursorrules file hides a delete-the-output instruction.
# v0.2.x scanned it as "0 files, clean, exit 0" — a false-clean on Cursor's own
# canonical agent-instruction file (fix-cursorrules-mdc-not-scanned). v0.3.0
# walks .cursorrules / .cursor/rules/*.mdc and flags the payload HIGH.
Type "cat .cursorrules"
Enter
Sleep 2000ms

Type "agentguard scan ."
Enter
Sleep 3500ms

# Pipe --json to a file and read it back: the version field now reads 0.3.0
# (fix-json-version-stale), and the full report + summary survive the pipe intact
# (the v0.2.0 stdout-truncation fix is preserved), so CI can parse it.
Type "agentguard scan . --json > report.json; head -n 6 report.json"
Enter
Sleep 3000ms

# The pasteable badge now links to the real repo (fix-badge-dead-link).
Type "agentguard badge"
Enter
Sleep 2500ms
