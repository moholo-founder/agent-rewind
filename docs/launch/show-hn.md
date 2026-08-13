# Show HN — ready to fire (AFTER npm publish)

**Submit at:** https://news.ycombinator.com/submit
**Best window:** Tue–Thu, 7–9am Pacific. Founder must be free for 4+ hours after.

## Title (80 chars max — use exactly this)

Show HN: Agent Rewind – flight recorder and undo button for AI agents

## URL

https://github.com/moholo-founder/agent-rewind

## First comment (post immediately after submitting — this is the real pitch)

Hi HN — I built this after watching the OpenClaw incident unfold: an AI
safety director told her agent "don't act until I tell you to," then watched
it start deleting her inbox. Context compaction had pushed the instruction
out of the agent's memory. She couldn't stop it from her phone.

Two things were missing: a black box and an undo button. Agent Rewind is
both. It sits between an agent and its tools (as an MCP proxy, or via Claude
Code hooks for native Bash/Edit/Write) and:

- journals every action to an append-only SQLite log (intent recorded
  BEFORE execution, outcome after)
- snapshots state before anything destructive runs — file deletes, bulk
  email wipes — so per-action Undo and "rewind to 3:41pm" actually work
- holds oversized actions (delete 40 files, wipe 200 messages) for human
  approval instead of executing
- has a kill switch that lives OUTSIDE the agent's context, so compaction
  and "creative reasoning" can't clear it

What it deliberately does NOT do: pretend everything is reversible. Bash
undo covers file effects inside the project tree (snapshotted+diffed per
command); processes, network calls, and a delivered email are honestly
reported as not-reversible. The per-action rewind report never claims more
than it restored.

Zero native deps (node:sqlite), 87 tests incl. byte-identical round-trips
for every undo path, BUSL-licensed (free for individuals/small teams,
Apache-2.0 after 4 years).

The 60-second demo: `pnpm demo` boots a scripted rogue agent that wipes a
200-message inbox; you press Rewind and watch it all come back.

Happy to answer anything — especially skeptical takes on the reversibility
model.

## Prepared answers for predictable objections

**"You can't really undo Bash."** Correct — and the product says so. We
snapshot the project tree before each command and diff after, so FILE
effects are restored exactly; processes/network/out-of-tree are reported
not-reversible per action. The design value is honest failure: a rewind
report never rounds up.

**"An agent could just bypass the proxy."** In MCP mode the agent only has
the tools the proxy exposes. In hooks mode, Claude Code fires PreToolUse on
every native tool call — the agent can't route around it from inside the
session. What we don't claim: protection against an agent with arbitrary
unhooked runtimes. Coverage table is in the README.

**"BUSL isn't open source."** Right, it's source-available; each version
converts to Apache-2.0 after 4 years. Free for individuals, education, and
companies under 25 people/$2M. We chose it over dual-AGPL because it's more
permissive for the people who'd actually be blocked by AGPL.

**"Snapshots of everything must be huge."** Content-addressed with dedup —
identical content is stored once ever, and an mtime cache means unchanged
files aren't even re-read. The 200-file demo tree snapshots in milliseconds
after the first pass.

**"Why not just use git / Time Machine?"** Git covers tracked source files
when you remember to commit; it doesn't cover the email your agent sent, the
inbox it wiped, or the approval gate BEFORE a bulk delete. The journal +
holds + kill switch are the point; file restore is table stakes.
