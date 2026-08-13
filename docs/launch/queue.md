# Launch queue — living checklist

## Blocked on founder (in order)
1. **npm publish** — `cd packages/agent-rewind && npm publish` (2FA prompt is yours). Everything below unlocks on this.
2. **HN submit** — after npm + rate-limit cooldown: fresh https://news.ycombinator.com/submit, copy from docs/launch/show-hn.md, first comment within a minute. Confirm live via /newest or ask the operator.
3. **MCP registry** — `brew install mcp-publisher && mcp-publisher login github && mcp-publisher publish` (device-code click).
4. **Send outreach** — docs/launch/outreach/: Simon Willison email, tldr;sec, Node Weekly/JS Weekly, TLDR AI, Console.dev (all drafted).
5. **Community posts** — Discord ×2, r/ClaudeAI, r/LocalLLaMA (drafted in outreach/community-posts.md).
6. **dev.to** — two articles ready in docs/launch/posts/ (publish Bash-undo first, kill-switch ~4 days later).
7. **Boost** — click the blue Boost button when ready (configured: video views, $50/5 days, saved audience).
8. **Outbound connector creds** (for the approval-gated posting pipeline): X developer token + SMTP creds as env vars.

## Running automatically
- Hourly launch monitor (drafts replies, flags ACTION NEEDED) — claude.ai/code/routines
- Daily GitHub traffic snapshots → metrics/traffic.jsonl
- Release asset download counter (v0.1.0)

## Done
- Plugin marketplace live in-repo: `/plugin marketplace add moholo-founder/agent-rewind` → `/plugin install agent-rewind@agent-rewind` (activates when npm is live)
- GitHub topics, org profile README (moholo-founder/moholo-founder)
- LinkedIn launch post scheduled + boost configured
- Show HN kit, registry kit, newsletters, Discord/Reddit posts, podcast pitch, 2 technical articles
