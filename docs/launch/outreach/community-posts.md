# Community posts (you paste; each needs your account)

## Claude Developers Discord — #show-and-tell (or equivalent)

> built a flight recorder + undo button for claude code sessions and MCP
> agents, after the openclaw inbox incident convinced me stop instructions
> can't live inside the context window.
>
> two modes:
> • MCP proxy: `npx -y agent-rewind` — journals every tool call, snapshots
> before destructive actions, blast-radius approval holds, per-action undo
> + rewind, timeline UI on :4821
> • hooks mode for native claude code tools: one `/plugin` install
> flight-records every Bash/Edit/Write — file edits AND bash file effects
> are undoable, dangerous commands escalate to a permission prompt, and the
> STOP switch is stored outside the agent's context so compaction can't
> clear it
>
> honest boundaries doc'd in the readme (bash undo = in-project file
> effects; a delivered email is gone; it's a recorder and gate, not a
> sandbox).
>
> https://github.com/moholo-founder/agent-rewind — would love brutal
> feedback, especially places where the reversibility claims break down.

## MCP community Discord — #showcase

Same text, lead with the MCP proxy mode, drop the plugin paragraph to one line.

## r/ClaudeAI

**Title:** I built a flight recorder + undo button for Claude Code sessions (one plugin install)

Body: Discord text above, plus the 14-sec demo GIF as the post media, plus:
"free for individuals (BUSL, converts to Apache-2.0), zero telemetry — the
journal lives in ~/.agent-rewind on your machine and nowhere else."

## r/LocalLLaMA

Angle shift: "works with any MCP client, not just Claude — the proxy is
model-agnostic. If your local agent can speak MCP, its actions become
recorded and reversible." Keep it technical, no pricing talk.
