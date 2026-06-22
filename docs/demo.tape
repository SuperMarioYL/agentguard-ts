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
Sleep 1500ms

Type "agentguard scan ."
Enter
Sleep 3500ms

# Pipe --json to a file and read it back: the full report + summary survive the
# pipe intact (v0.2.0 fix-stdout-truncation-on-exit), so CI can parse it.
Type "agentguard scan . --json > report.json; cat report.json | head -n 20"
Enter
Sleep 3000ms
