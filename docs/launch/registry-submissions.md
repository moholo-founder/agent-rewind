# Directory & registry submissions — checklist

All blocked on: `npm login` + `npm publish` in packages/agent-rewind.
(package.json already carries `mcpName: io.github.moholo-founder/agent-rewind`;
`server.json` is at the repo root, registry-schema valid.)

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

```bash
brew install mcp-publisher   # or: go install / release binary
cd "/Users/krzysztofpietroszek/Desktop/Agent Rewind"
mcp-publisher login github    # device-code flow — one browser click
mcp-publisher publish         # reads ./server.json
```

## 2. mcp.so
Submit form at https://mcp.so/submit — GitHub URL + description. 2 minutes.

## 3. Smithery (smithery.ai)
"Add server" with the GitHub repo. Stdio server; config keys documented in
server.json environment_variables.

## 4. Glama (glama.ai/mcp/servers)
Auto-indexes GitHub; can claim the listing with the founders account.

## 5. awesome-mcp-servers PR
Fork https://github.com/punkpeye/awesome-mcp-servers, add under a fitting
category (Developer Tools / Security):

`- [agent-rewind](https://github.com/moholo-founder/agent-rewind) - Flight
recorder + undo for AI agents: journals every tool call, snapshots before
destructive actions, per-action undo, rewind, and a durable kill switch.`

## 6. awesome-claude-code PR (hooks mode)
Same pattern — hooks-mode blurb emphasizing native Bash/Edit/Write
flight-recording and the STOP switch.

## Description string (reuse everywhere)

> Flight recorder + undo button for AI agents. Journals every tool call,
> snapshots state before destructive actions, holds oversized operations for
> approval — with per-action Undo, Rewind-to-a-point-in-time, and a kill
> switch the agent cannot clear. Zero native dependencies.
