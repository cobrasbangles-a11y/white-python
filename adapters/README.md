# Adapters

White Python's whole interface is two commands:

```sh
white-python start          # the agent is working
white-python stop           # the agent wants you, or is done
```

Anything that can run a shell command at those two moments can drive it. Pass
`--session <id>` if a tool runs several agents at once and you want their
windows tracked separately; otherwise the working directory is used.

| Agent | How | File |
| --- | --- | --- |
| Claude Code | Native hooks — `white-python install` | `claude-code.json` |
| Codex | `notify` on turn end + `white-python wrap` | `codex.toml` |
| Aider, opencode, any CLI | `white-python wrap --idle` | `generic.sh` |
| Make / npm / just | `white-python start` and `white-python stop` around the task | `Makefile.example` |

## Which one do I want?

**If your agent has real lifecycle hooks**, use them — that's the only way to
distinguish "asked a question" from "finished", and it costs nothing at runtime.
Claude Code is the reference case.

**If it doesn't**, use `white-python wrap --idle N`. The wrapper watches the command's
output and treats N seconds of silence from a still-running process as "it's
waiting for you": the feeds close, and reopen when it starts talking again.

```sh
white-python wrap --idle 8 -- aider
white-python wrap --idle 8 -- opencode
```

Pick N above the agent's normal thinking pauses — 8 seconds is a reasonable
start. Too low and the feeds flap; too high and you scroll through the question.

One caveat: `--idle` has to pipe the command's output in order to watch it,
which breaks full-screen TUIs that redraw the terminal. For those, use plain
`white-python wrap` (output is inherited untouched, feeds close on exit) or wire
`white-python start` / `white-python stop` into the tool directly.
