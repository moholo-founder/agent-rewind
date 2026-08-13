# Engineering state — handoff (2026-08-13)

Continuation doc for Claude Code sessions on the CODE side. Promotion lives
in a separate workspace (`~/Desktop/Agent Rewind Promo`) — do not mix.

## Where things stand

- **Published**: `agent-rewind@0.1.0` on npm (account `moholo`, 2FA passkey).
  `npx -y agent-rewind` verified cold: 2s start, 12 tools, intercept+journal+
  snapshot working. `mcpName: io.github.moholo-founder/agent-rewind` is set.
- **Repo**: public, github.com/moholo-founder/agent-rewind. CI green
  (ubuntu/macos/windows × Node 22/24). 91 tests… precisely: core 22,
  connectors 23, proxy 14, api 12, agent-rewind 14, web 1, demo 1 = 87.
- **License**: BUSL-1.1 (Moholo Inc.), commercial tier, terms, CLA in root.
  TERMS.md promises ZERO telemetry — hard product constraint, never violate.
- **Engine floor**: Node 22.13 (unflagged node:sqlite). No native deps.
- **This repo dogfoods itself**: `.claude/settings.json` (gitignored,
  machine-specific) wires hooks mode → journal at `~/.agent-rewind`.
  `.mcp.json` attaches the MCP proxy to sessions here (UI :4821).
- **Plugin marketplace in-repo**: `/plugin marketplace add
  moholo-founder/agent-rewind` → `/plugin install agent-rewind@agent-rewind`
  (hooks via `npx -y agent-rewind hook`). Spec-checked but not yet
  user-tested in a real session — verify on next session start.

## Architecture cheat sheet

pnpm monorepo: `core` (journal/snapshots/policy/rewind — append-only SQLite
w/ trigger enforcement, content-addressed fsynced blobs, HMAC redaction),
`proxy` (AgentRewindRuntime = the gate; intent-first journaling, atomic
approval claim, STOP engaged during rewind, cc-file + cc-bash-effect undo),
`connectors` (fs sandboxed + mock email w/ recall windows; admin__ tools
routeless), `api` (REST+SSE, strict input validation), `web` (timeline UI),
`agent-rewind` (bundled CLI: serve/ui/hook/hooks-install/fs-server/
email-server), `demo`. Non-negotiables: reads pass untouched; unknown tools
held; reports never round up; capture-before-execute or refuse.

## Engineering backlog (priority order)

1. ~~**Real outbound connectors**~~ DONE (2026-08-13, unreleased): `smtp`
   connector (nodemailer, pure JS) + `x` connector (API v2, hand-rolled
   OAuth 1.0a signer verified against X's doc vector). Both default
   `holdThreshold: 0` → every send/post HELD; delete-tweet compensator via
   persisted JSONL post log (survives restarts); sent email honestly
   not-reversible with full draft archived as snapshot. Creds env-only,
   passed explicitly to child servers (`AGENT_REWIND_SMTP_*`,
   `AGENT_REWIND_X_*`), never in tool args → never in journal. Needs:
   version bump + npm publish (founder passkey), then live-fire test with
   real creds before the marketing pipeline uses it.
2. **Gate verdict on every journal row** (from reviewer signal): record WHY
   each action passed/held ("blast radius 3 ≤ 25, snapshot captured") and
   show in row detail. ~1h. Feeds #3.
3. **OTel exporter for the journal** — span per tool call, attributes:
   blast radius/risk/verdict. An OpenTelemetry-contributor ICP asked for
   this shape (see promo handoff).
4. **Coverage table in README** (MCP mode vs hooks mode vs uncovered).
5. Held-action raw-args persistence across restarts (encrypted at rest?);
   empty-dir restoration on move-undo; dir-onto-dir move edge.
6. Registry follow-ups: `mcp-publisher` publish (needs founder device-code
   click), keep server.json version in lockstep with npm.

## Operational notes

- Version bumps: package.json + server.json + marketplace.json +
  plugin.json (4 places) — consider a bump script.
- npm publish requires founder (passkey 2FA, browser ceremony) — or ask
  founder to mint a granular automation token into ~/.npmrc for CI.
- GitHub Actions billing on PRIVATE repos is broken on this account —
  everything public-repo-only for now.
- Hourly launch-monitor routine exists (cloud, Sonnet) — it's a PROMO
  concern; don't duplicate its GitHub polling in engineering tooling.
- Windows CI: heavy 200-item tests carry 30s timeouts (fsync cost) — keep.
