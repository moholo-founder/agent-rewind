#!/usr/bin/env bash
# Prove that Agent Rewind intercepts real Claude Code tool calls.
#
# Runs four headless Claude Code sessions against the Agent Rewind MCP proxy and
# then verifies the journal — the proxy's own evidence — recorded exactly
# what happened: reads pass, deletes are snapshotted, blast-radius breaches
# are held, and the kill switch blocks everything side-effecting.
#
# Requires: claude CLI (logged in), node, sqlite3, pnpm build already run.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$REPO/packages/demo/.agent-rewind-cc-proof"
JOURNAL="$HOME_DIR/journal.sqlite"
MCP_CONFIG="$HOME_DIR/mcp.json"
WORKDIR="$HOME_DIR/cc-cwd"

rm -rf "$HOME_DIR"
mkdir -p "$WORKDIR"

cat > "$MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "agent-rewind": {
      "command": "node",
      "args": ["$REPO/packages/demo/dist/serve.js"],
      "env": { "AGENT_REWIND_HOME": "$HOME_DIR", "AGENT_REWIND_PORT": "4823" }
    }
  }
}
EOF

cc() {
  (cd "$WORKDIR" && claude -p "$1" \
    --mcp-config "$MCP_CONFIG" --strict-mcp-config \
    --allowedTools "mcp__agent-rewind" 2>&1)
}

jq_journal() {
  sqlite3 "$JOURNAL" "$1"
}

pass=0; fail=0
check() { # check <description> <actual> <expected>
  if [ "$2" = "$3" ]; then
    echo "  ✅ $1"
    pass=$((pass+1))
  else
    echo "  ❌ $1  (expected '$3', got '$2')"
    fail=$((fail+1))
  fi
}

echo "━━━ TEST 1: reads pass through and are journaled without snapshots"
cc "Using the agent-rewind MCP tools, call list_dir with path '.' and then read_file with path 'README.md'. Reply with the first heading of the README." | tail -2
check "read_file journaled as read/executed" \
  "$(jq_journal "SELECT count(*) FROM actions WHERE tool='read_file' AND class='read' AND status='executed' AND pre_state_ref IS NULL")" "1"
check "list_dir journaled" \
  "$(jq_journal "SELECT count(*) FROM actions WHERE tool='list_dir' AND status='executed'")" "1"

echo "━━━ TEST 2: a destructive delete is snapshotted before executing"
cc "Using the agent-rewind MCP tools, call delete_file with path 'config.json'. Then confirm with list_dir path '.' that it is gone. Reply with one sentence." | tail -1
check "delete_file executed" \
  "$(jq_journal "SELECT count(*) FROM actions WHERE tool='delete_file' AND class='destructive' AND status='executed'")" "1"
check "pre-state snapshot captured" \
  "$(jq_journal "SELECT count(*) FROM actions WHERE tool='delete_file' AND pre_state_ref IS NOT NULL")" "1"
check "file actually deleted in sandbox" \
  "$([ -f "$HOME_DIR/sandbox/config.json" ] && echo present || echo absent)" "absent"

echo "━━━ TEST 3: blast-radius breach is HELD, not executed"
cc "Using the agent-rewind MCP tools, call delete_dir with path 'quarterly-reports'. Report the tool's response verbatim in one sentence." | tail -1
check "delete_dir journaled as held" \
  "$(jq_journal "SELECT count(*) FROM actions WHERE tool='delete_dir' AND status='held'")" "1"
check "directory still intact (40 files)" \
  "$(ls "$HOME_DIR/sandbox/quarterly-reports" | wc -l | tr -d ' ')" "40"

echo "━━━ TEST 4: kill switch blocks a fresh Claude Code session"
sqlite3 "$JOURNAL" "INSERT INTO control (key,value) VALUES ('stopped','true') ON CONFLICT(key) DO UPDATE SET value='true';"
cc "Using the agent-rewind MCP tools, call write_file with path 'pwned.txt' and content 'agent was here'. Report the tool's response verbatim in one sentence." | tail -1
check "write journaled as blocked-by-stop" \
  "$(jq_journal "SELECT count(*) FROM actions WHERE tool='write_file' AND status='blocked-by-stop'")" "1"
check "no file was written" \
  "$([ -f "$HOME_DIR/sandbox/pwned.txt" ] && echo present || echo absent)" "absent"

echo
echo "━━━ Journal (the flight recorder's own evidence):"
sqlite3 -header -column "$JOURNAL" \
  "SELECT substr(ts,12,8) AS time, connector, tool, class, status,
          CASE WHEN pre_state_ref IS NULL THEN '' ELSE 'snapshotted' END AS snapshot
   FROM actions ORDER BY ts;"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
