# Newsletter submissions

## tldr;sec (Clint Gibler) — https://tldrsec.com (submission via site/email)

**Blurb:**

> **Agent Rewind** — an open(-ish) source flight recorder + undo button for
> AI agents. Sits between the agent and its tools as an MCP proxy (or Claude
> Code hooks for native shell/file tools): append-only action journal with
> pre-execution intent records, content-addressed snapshots before
> destructive actions, blast-radius approval holds, per-action undo/rewind,
> and a kill switch stored outside the agent's context — built in direct
> response to the OpenClaw inbox-deletion incident, where context compaction
> erased the operator's stop instruction. Notably honest about coverage:
> Bash undo is scoped to in-project file effects; delivered email is
> reported not-reversible. https://github.com/moholo-founder/agent-rewind

## Node Weekly / JavaScript Weekly — https://cooperpress.com/publications (submit link on each issue)

**Blurb:**

> Agent Rewind 0.1 — a flight recorder and undo button for AI agents, in
> pure Node with zero native dependencies (SQLite via the new `node:sqlite`
> built-in). One `npx -y agent-rewind` boots an MCP interception proxy with
> an append-only journal, pre-action snapshots, and a live timeline UI with
> per-action Undo and Rewind. Node 22.13+.
> https://github.com/moholo-founder/agent-rewind

## TLDR AI — https://tldr.tech (advertise/submit links on site)

**Blurb:**

> **Agent Rewind (GitHub Repo)** — a flight recorder + undo button for AI
> agents. Records every tool call, snapshots state before destructive
> actions, holds bulk operations for human approval, and ships a kill switch
> the agent can't clear — the demo restores a 200-message inbox a rogue
> agent deleted, in one click.

## Console.dev (devtools newsletter) — https://console.dev/submit

Same Node Weekly blurb; they favor a "what's interesting technically" line:
append-only journal enforced by SQLite triggers; content-addressed snapshot
store; time-bounded reversibility (email recall windows) reported honestly.
