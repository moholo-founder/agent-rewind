#!/usr/bin/env node
/**
 * Agent Rewind stdio entry point: boot the full stack and expose the proxy over
 * stdio for any MCP client (Claude Desktop, Claude Code, Cursor, ...).
 *
 * The MCP client spawns this process; the agent talks MCP on stdin/stdout.
 * Downstream connector servers are spawned as stdio children, and the
 * timeline HTTP API listens on localhost for the human operator.
 *
 * Usage:
 *   node dist/main.js --sandbox <dir> [--data <dir>] [--port <n>] [--no-email]
 *
 * IMPORTANT: never write logs to stdout here — stdout is the MCP wire.
 * All human-facing output goes to stderr.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createEmailConnector,
  createFilesystemConnector,
} from "@agentrewind/connectors";
import { AgentRewindRuntime, createProxyServer } from "@agentrewind/proxy";
import { createApiServer } from "./server.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const sandboxRoot = arg("sandbox");
if (!sandboxRoot) {
  console.error(
    "Usage: agent-rewind --sandbox <dir> [--data <dir>] [--port <n>] [--no-email]",
  );
  process.exit(1);
}
const dataDir = arg("data") ?? path.join(sandboxRoot, "..", ".agent-rewind");
const port = Number(arg("port") ?? 4820);

const here = path.dirname(fileURLToPath(import.meta.url));
const connectorsDist = path.resolve(here, "../../connectors/dist");

async function spawnDownstream(name: string, scriptArgs: string[]): Promise<Client> {
  const client = new Client({ name: `agent-rewind-runtime-${name}`, version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: scriptArgs,
      stderr: "inherit",
    }),
  );
  return client;
}

const runtime = new AgentRewindRuntime({
  dbPath: path.join(dataDir, "journal.sqlite"),
  snapshotDir: path.join(dataDir, "snapshots"),
});

// Filesystem connector (always on).
const fsClient = await spawnDownstream("fs", [
  path.join(connectorsDist, "fs/main.js"),
  sandboxRoot,
]);
const { manifest: fsManifest } = createFilesystemConnector({ root: sandboxRoot });
await runtime.registerConnector(fsManifest, fsClient);

// Mock email connector (on by default for the demo; --no-email to skip).
if (!flag("no-email")) {
  const emailClient = await spawnDownstream("email", [
    path.join(connectorsDist, "email/main.js"),
    path.join(dataDir, "email.sqlite"),
  ]);
  const { manifest: emailManifest } = createEmailConnector();
  await runtime.registerConnector(emailManifest, emailClient);
}

// Operator API (and, once built, the timeline UI) on localhost only.
const app = createApiServer(runtime);
app.listen(port, "127.0.0.1", () => {
  console.error(`[agent-rewind] timeline API on http://127.0.0.1:${port} — sandbox: ${sandboxRoot}`);
});

// Agent-facing proxy over stdio. This must be last: from here on the MCP
// client owns stdin/stdout.
await createProxyServer(runtime).connect(new StdioServerTransport());
console.error("[agent-rewind] proxy ready on stdio");
