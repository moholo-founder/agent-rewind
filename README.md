# Backstop

[![CI](https://github.com/moholo-founder/agent-rewind/actions/workflows/ci.yml/badge.svg)](https://github.com/moholo-founder/agent-rewind/actions/workflows/ci.yml)

**A flight recorder + undo button for AI agents.**

Backstop sits between an AI agent and its tools as a transparent MCP proxy. Every
action flows through it and is journaled, snapshotted for reversibility, risk-classified,
and policy-gated before it executes. A live web timeline gives a human operator
per-action **Undo**, a global **Rewind to time T**, a persistent **Kill Switch**, and an
approval tray for held actions.

Design values: legibility over cleverness · safety-by-default (unknown/destructive
actions are held, not executed) · honest failure (a failed undo is reported loudly,
never faked).

## Current state — all v1 milestones complete

| Milestone | Status |
| --- | --- |
| M0 — Scaffold | ✅ |
| M1 — Journal + snapshot core | ✅ |
| M2 — Filesystem connector + compensators | ✅ |
| M3 — Proxy + policy gate | ✅ |
| M4 — Mock email connector | ✅ |
| M5 — API (REST + SSE) | ✅ |
| M6 — Web timeline + demo | ✅ |

58 tests across the workspace, including a do→undo→byte-identical round trip for
every compensator, proxy integration tests through the real MCP SDK, and a
deliberately induced undo failure asserting the system reports it honestly.

## The demo (the money shot)

```bash
pnpm install
pnpm demo
```

Then open **http://localhost:4820** and watch. A scripted rogue agent:

1. reads around the workspace and inbox (reads pass through untouched),
2. clobbers `config.json` (disables backups), shuffles files around,
3. queues two embarrassing company-wide/vendor emails,
4. deletes the README, **wipes the entire 200-message inbox**,
5. tries to bulk-delete 40 quarterly reports — **held** by the blast-radius gate.

Operator click-path:

1. **Approve** the held 40-file delete in the amber tray — watch it execute.
2. Click any row for before/after **diffs** (file content diff, inbox contents, folder moves).
3. Press **⏪ Rewind…** (top right) → preview lists everything that will be undone,
   newest first → **Confirm** → the report shows per-action outcomes and the
   timeline flips to `undone` as 200 emails and every file come back.
4. The queued emails are **recalled from the outbox** (3-minute delivery window).
   Wait out the window before rewinding and the report will honestly say
   `not-reversible — already delivered` instead.
5. Hit **STOP** — every further side-effecting call is refused and journaled as
   `blocked-by-stop` until you press RESUME. The flag lives in Backstop's SQLite,
   not in the agent's context, so no amount of agent "creativity" or context
   compaction clears it.

Demo state lives in `packages/demo/.backstop-demo/` and is wiped on each run.

## Install / use with an MCP client

Backstop is pure JavaScript — **zero native dependencies, no compiler, no
toolchain** (SQLite comes from Node's built-in `node:sqlite`). Requires
Node 22.5+. Verified by CI on Linux, macOS, and Windows (Node 22 & 24).

Once published to npm (`packages/backstop`, name `backstop-mcp`), registration
is one block in any MCP client config:

```json
{
  "mcpServers": {
    "backstop": { "command": "npx", "args": ["-y", "backstop-mcp"] }
  }
}
```

Or from this repo today (used by the project's own `.mcp.json`):

```json
{
  "mcpServers": {
    "backstop": { "command": "node", "args": ["packages/demo/dist/serve.js"] }
  }
}
```

Either way the timeline UI comes up on http://localhost:4821 and every tool
call the agent makes is journaled, snapshotted, gated, and reversible. State
(including the kill switch) persists in `~/.backstop` (npx) or
`packages/demo/.backstop-live` (repo).

## How to run (dev)

Requires Node 22.5+ and pnpm 9+.

```bash
pnpm install
pnpm -r build     # build all packages
pnpm -r test      # run all tests
pnpm demo         # build + boot the full demo stack on :4820
```

For UI development: `pnpm demo` in one terminal, `pnpm --filter @backstop/web dev`
in another (Vite dev server proxies `/api` to :4820).

To put Backstop in front of a real MCP client, run the downstream servers it
should wrap (e.g. `node packages/connectors/dist/fs/main.js <sandbox-root>`) and
wire `BackstopRuntime` + `createProxyServer` over stdio — `packages/demo/src/index.ts`
is the reference wiring.

## Layout

```
packages/
  core/         # journal, snapshot store, policy engine, reversibility model, rewind engine
  proxy/        # BackstopRuntime (the gate) + agent-facing MCP server
  connectors/   # filesystem + mock-email: MCP servers, manifests, compensators
  api/          # express + SSE, serves timeline data and undo/rewind commands
  web/          # React timeline UI
  demo/         # seed data + scripted rogue agent
```

## Architecture

```
[ MCP client / agent ]
        │  (MCP)
        ▼
  Backstop Proxy: classify → policy gate → capture pre-state →
                  forward downstream → journal + SSE → return result
        │  (MCP, stdio in the demo)
        ▼
[ downstream MCP servers: filesystem, mock-email ]
```

Key rules, all enforced in code (not convention):

- **Reads pass through untouched** — never gated, never snapshotted.
- **Per-connector capability manifests** declare class/compensator/blast-radius per
  tool. Undeclared tools default to hold-for-approval, never silent execution.
- **The journal is append-only** — SQLite triggers ABORT deletes and identity
  rewrites; undo/rewind append compensating entries linked via `caused_by`.
- **Rewind is LIFO by execution time** (not journal time — held actions approved
  later execute out of order), each undo in its own try/catch, and the report
  never claims restoration that didn't happen (`fullyRestored` requires every
  outcome to be `undone`).
- **STOP is durable** — a flag in Backstop's own SQLite; only a human RESUME
  clears it. Blocked calls are journaled as `blocked-by-stop`.
- **No secrets in the journal** — a global denylist redactor (values → shape +
  hash + length) plus per-tool `redactFields` for connector opt-outs. Mock email
  bodies are synthetic and stored; a real connector should opt its bodies out.
- **Snapshots are content-addressed** (sha256 → blob) and integrity-checked on
  read — a corrupted snapshot fails loudly rather than restoring garbage.
- **The filesystem sandbox refuses escapes** — lexical `..`/absolute checks plus
  realpath symlink containment, enforced in both the downstream server and the
  compensators.
- **Email sends are time-bounded reversible** — recallable while in the outbox
  window, honestly `not-reversible` after delivery.

## Design notes / decisions made along the way

- **Held actions and restarts:** raw (unredacted) arguments for held actions live
  only in runtime memory. If Backstop restarts, a held action can no longer
  execute and is auto-rejected on approval attempt — safe by construction.
- **Approval under STOP:** approving a held action while the kill switch is
  tripped is refused; resume first.
- **Capture-before-execute is load-bearing:** if pre-state capture fails, the
  action is refused rather than executed un-undoably.
- **Undo of a `move` leaves any directories it created** (empty `archive/` after
  moving a file back). Files are byte-identical; empty-dir tracking is a
  fast-follow nicety.

## Fast-follow (explicit v1 non-goals)

- Real Gmail/Slack/Stripe OAuth connectors (v1 email is a self-contained mock;
  the manifest/compensator interface is designed for a third connector without
  touching core).
- Multi-user auth, accounts, billing, cloud deployment.
- ROI/attribution analytics and enterprise audit export (later products off the
  same journal).
- Distributed/HA storage (v1 is local disk + SQLite; note: `better-sqlite3` is a
  native module pinned to the Node ABI — rebuild on Node major upgrades).
- HTTP/SSE MCP transport (v1 is stdio + in-memory).
- Persisting held-action payloads across restarts; empty-directory restoration.
