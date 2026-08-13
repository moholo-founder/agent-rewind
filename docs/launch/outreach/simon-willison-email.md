# Email: Simon Willison

**To:** contact via simonwillison.net (or reply to a relevant post/toot)
**Subject:** A flight recorder + undo button for agents (built after the OpenClaw inbox incident)

Hi Simon,

The OpenClaw incident — the safety director whose "don't act until I tell
you" got garbage-collected by context compaction while her agent deleted her
inbox — convinced me the missing layer isn't better prompts, it's
enforcement that lives outside the context window entirely.

So I built Agent Rewind: an MCP proxy (plus Claude Code hooks for native
Bash/Edit/Write) that journals every tool call to an append-only log,
snapshots state before anything destructive runs, holds oversized actions
for human approval, and has a kill switch stored in its own SQLite — so no
amount of compaction or creative reasoning clears it. Per-action Undo and
"rewind to 3:41pm" actually restore things, byte-identical.

The part I suspect you'd find most interesting is what it refuses to claim:
Bash undo covers file effects inside the project tree (tree-snapshot +
diff per command); processes, network calls, and a delivered email are
reported not-reversible, per action, in the rewind report. The design rule
is that the report never rounds up.

Repo (source-available, BUSL → Apache-2.0 after 4 years):
https://github.com/moholo-founder/agent-rewind
14-second demo of 200 deleted emails coming back is at the top of the README.

If it's not interesting, no reply needed — but if you poke at it and find
where the honesty breaks down, I genuinely want that email.

Kristof Pietro
Founder, Moholo Inc.
