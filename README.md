# Backstop

**A flight recorder + undo button for AI agents.**

Backstop sits between an AI agent and its tools as a transparent MCP proxy. Every
action flows through it and is journaled, snapshotted for reversibility, risk-classified,
and policy-gated before it executes. A live web timeline gives a human operator
per-action **Undo**, a global **Rewind to time T**, a persistent **Kill Switch**, and an
approval tray for held actions.

Design values: legibility over cleverness · safety-by-default (unknown/destructive
actions are held, not executed) · honest failure (a failed undo is reported loudly,
never faked).

## Current state — Milestone 0 (scaffold)

The pnpm monorepo is scaffolded with all packages stubbed, TypeScript strict mode,
and Vitest wired with placeholder tests. No product functionality yet.

| Milestone | Status |
| --- | --- |
| M0 — Scaffold | ✅ done |
| M1 — Journal + snapshot core | not started |
| M2 — Filesystem connector + compensators | not started |
| M3 — Proxy + policy gate | not started |
| M4 — Mock email connector | not started |
| M5 — API (REST + SSE) | not started |
| M6 — Web timeline + demo | not started |

## How to run

Requires Node 20+ and pnpm 9+.

```bash
pnpm install
pnpm -r build
pnpm -r test
```

`pnpm --filter @backstop/web dev` starts the (placeholder) timeline UI.

## Layout

```
packages/
  core/         # journal, snapshot store, policy engine, reversibility model
  proxy/        # MCP interception proxy (server<->client), classification
  connectors/   # filesystem + mock-email capability manifests & compensators
  api/          # express + SSE, serves timeline data and undo/rewind commands
  web/          # React timeline UI
  demo/         # seed data + scripted agent that triggers the money-shot demo
```

## Architecture (target)

```
[ MCP client / agent ]
        │  (stdio, MCP)
        ▼
  Backstop Proxy: classify → policy gate → capture pre-state →
                  forward downstream → journal + SSE → return result
        │  (stdio, MCP)
        ▼
[ downstream MCP servers: filesystem, mock-email ]
```

Key rules:

- Reads are a pure pass-through — never gated, never snapshotted.
- Classification and reversibility are per-connector declarations; unknown tools
  default to hold-for-approval, never silent execution.
- The journal is append-only: undo/rewind append compensating events and never
  mutate original rows.
- The Kill Switch is a durable flag in Backstop itself — outside the agent's
  context — so context compaction cannot erase it.
- No secrets in the journal: `args_redacted` stores shapes, hashes, lengths, and
  paths, not credential values.

## Design notes for review

- **Time-bounded reversibility**: `send_message` is reversible only while it sits
  in the outbox window. The static manifest `class` can't express that, so the
  journal/UI will carry a per-action reversibility state that can expire
  (`not-reversible (window elapsed)`), designed in from M1.
- **Rewind order**: actions that were held and later approved execute out of
  journal order. Rewind will undo in LIFO order of *execution* time; both
  timestamps get journaled.
- **Demo vs. blast radius**: deleting the 200-item folder deliberately trips the
  blast-radius hold; the demo script has the operator approve it first — showing
  the gate working is part of the show.

## Fast-follow (explicit v1 non-goals)

- Real Gmail/Slack/Stripe OAuth connectors (v1 email is a self-contained mock).
- Multi-user auth, accounts, billing, cloud deployment.
- ROI/attribution analytics and enterprise audit export.
- Distributed/HA storage (v1 is local disk + SQLite).
- HTTP/SSE MCP transport (v1 is stdio only).
