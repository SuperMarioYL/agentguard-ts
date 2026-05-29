# AgentGuard demo — record with: vhs assets/demo.tape
# Produces assets/demo.gif (and you can also capture an asciinema .cast with:
#   asciinema rec assets/demo.cast -c "node dist/cli.js scan test/fixtures")
#
# Target: ~30s, showing the flagship jqwik catch end to end.

Output assets/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 700
Set Theme "Dracula"
Set TypingSpeed 60ms
Set Padding 20

Type "# Scan a dependency for hidden instructions to your coding agent"
Enter
Sleep 1s

Type "npx agentguard scan test/fixtures"
Enter
Sleep 4s

Type "# 3 HIGH findings — the real jqwik payload, caught with file:line"
Enter
Sleep 2s

Type "echo \"exit code: $?\""
Enter
Sleep 2s

Type "# Clean repo? Paste the badge into your README:"
Enter
Sleep 1s

Type "npx agentguard badge"
Enter
Sleep 3s
