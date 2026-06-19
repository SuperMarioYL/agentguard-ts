# vhs tape — AgentGuard happy path.
# Render in CI via .github/workflows/demo.yml, or locally:
#   npm run build && npm link        # puts `agentguard` on PATH
#   vhs docs/demo.tape               # writes assets/demo.gif
Output assets/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 700
Set Theme "Dracula"
Set TypingSpeed 55ms
Set Padding 20

Type "# 1) Scan a dependency for hidden instructions to your coding agent"
Enter
Sleep 700ms
Type "agentguard scan test/fixtures"
Enter
Sleep 4s

Type "# 3 HIGH findings — the real jqwik payload, caught with file:line"
Enter
Sleep 2s
Type "echo \"exit code: $?\""
Enter
Sleep 2s

Type "# 2) Clean repo? Paste the badge into your README:"
Enter
Sleep 700ms
Type "agentguard badge"
Enter
Sleep 3s
