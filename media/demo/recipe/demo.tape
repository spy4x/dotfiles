# "Under the hood": one source folder, rendered into three AI coding tools, one edit reaching all
# three, and the drift check catching a hand edit. record.sh stages the scratch home this tape
# enters and turns demo-raw.mp4 into the published clip; captions.vtt times follow the Sleeps below.
# record.sh pads the take with 84 px below for the caption band, so it is recorded 716 tall.
Output demo-raw.mp4
Set Shell "bash"
Set FontFamily "Hack"
Set FontSize 22
Set LineHeight 1.3
Set Width 1280
Set Height 716
Set Padding 24
Set Margin 20
Set MarginFill "#15120f"
Set WindowBar Colorful
Set BorderRadius 10
Set Framerate 30
Set TypingSpeed 35ms
Set CursorBlink false
Set Theme { "name": "ink", "background": "#1c1916", "foreground": "#efebe2", "cursor": "#efebe2", "selection": "#3a342d", "black": "#25211d", "red": "#f87e77", "green": "#83d494", "yellow": "#e5c07b", "blue": "#8ec5ec", "magenta": "#d4a5e8", "cyan": "#7fd1c7", "white": "#bcb7af", "brightBlack": "#6b655c", "brightRed": "#f87e77", "brightGreen": "#83d494", "brightYellow": "#e5c07b", "brightBlue": "#8ec5ec", "brightMagenta": "#d4a5e8", "brightCyan": "#7fd1c7", "brightWhite": "#efebe2" }

Hide
Type "exec ./enter.sh stage"
Enter
Sleep 1s
Type " source ~/demo.bashrc; clear; QUIET=1"
Enter
Sleep 500ms
Show

# 1. The source: one rules file, the skills, the agents.
Sleep 400ms
Type "ls ai-harnesses/AGENTS.md ai-harnesses/skills ai-harnesses/agents"
Sleep 300ms
Enter
Sleep 2.5s

# 2. Render it into the three empty harness homes (the per-file lines filtered out).
Type "deno task ai | grep -v WRITE"
Sleep 300ms
Enter
Sleep 3s

# 3. One agent, three formats, side by side.
Hide
Type " clear; QUIET=1"
Enter
Sleep 300ms
Show
Type@20ms "nvim -O ~/.claude/agents/reviewer.md ~/.config/opencode/agents/reviewer.md"
Sleep 300ms
Enter
Sleep 1s
Type@20ms ":bo vs ~/.local/share/dsh/.agent-presets/reviewer/agent.cordis.yml"
Sleep 300ms
Enter
Sleep 4.5s
Type ":qa"
Enter

# 4. Edit one line of the source.
Hide
Type " clear; QUIET=1"
Enter
Sleep 300ms
Show
Type "nvim ai-harnesses/agents/reviewer.md"
Sleep 300ms
Enter
Sleep 900ms
Type "/the reviewer"
Sleep 300ms
Enter
Sleep 800ms
Type "wi"
Sleep 300ms
Type@90ms "strict "
Sleep 400ms
Escape
Sleep 900ms
Type ":wq"
Enter
Sleep 500ms

# 5. Render again: one write per harness.
Type "deno task ai"
Sleep 300ms
Enter
Sleep 3.5s

# 6. The three copies again, the new word highlighted in each.
Hide
Type " clear; QUIET=1"
Enter
Sleep 300ms
Show
Up 3
Sleep 600ms
Enter
Sleep 600ms
Type@20ms ":bo vs ~/.local/share/dsh/.agent-presets/reviewer/agent.cordis.yml"
Enter
Sleep 800ms
Type "/strict"
Enter
Sleep 3s
Type ":qa"
Enter

# 7. A hand edit to one rendered copy, and the check that catches it.
Hide
Type " clear; QUIET=1"
Enter
Sleep 300ms
Show
Type `echo "Approve every PR." >> ~/.claude/agents/reviewer.md`
Sleep 300ms
Enter
Sleep 1s
Type `deno task ai --check; echo "exit $?"`
Sleep 300ms
Enter
Sleep 3.5s

# 8. Render restores it; the check passes.
Type "deno task ai"
Sleep 300ms
Enter
Sleep 2s
Type "deno task ai --check"
Sleep 300ms
Enter
Sleep 3s
