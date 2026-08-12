#!/usr/bin/env node
/**
 * Agent Rewind live proxy over stdio — the entry point a real MCP client
 * (Claude Code, Claude Desktop/Cowork, anything MCP) launches.
 *
 *   node packages/demo/dist/serve.js
 *
 * stdin/stdout speak MCP to the agent; ALL logging goes to stderr. The
 * timeline API + UI come up on AGENT_REWIND_PORT (default 4821) so a human can
 * watch/undo/stop while the agent works. State persists across runs in
 * AGENT_REWIND_HOME (default packages/demo/.agent-rewind-live) — including the STOP
 * flag: if you tripped the kill switch, a freshly launched proxy is still
 * stopped until a human resumes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApiServer } from "@agentrewind/api";
import {
  createEmailConnector,
  createFilesystemConnector,
} from "@agentrewind/connectors";
import { AgentRewindRuntime, createProxyServer } from "@agentrewind/proxy";
import { seedDemoSandbox } from "@agentrewind/connectors";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const home = process.env.AGENT_REWIND_HOME
  ? path.resolve(process.env.AGENT_REWIND_HOME)
  : path.resolve(here, "../.agent-rewind-live");
const sandboxRoot = path.join(home, "sandbox");
const port = Number(process.env.AGENT_REWIND_PORT ?? 4821);
const sendWindowMs = Number(process.env.AGENT_REWIND_SEND_WINDOW_MS ?? 180_000);

const log = (msg: string) => console.error(`[agent-rewind] ${msg}`);

async function main(): Promise<void> {
  if (!fs.existsSync(sandboxRoot)) {
    seedDemoSandbox(sandboxRoot);
    log(`Seeded sandbox at ${sandboxRoot}`);
  }

  const runtime = new AgentRewindRuntime({
    dbPath: path.join(home, "journal.sqlite"),
    snapshotDir: path.join(home, "snapshots"),
  });

  const fsClient = new Client({ name: "agent-rewind-runtime-fs", version: "0.1.0" });
  await fsClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, "packages/connectors/dist/fs/main.js"), sandboxRoot],
    }),
  );
  const { manifest: fsManifest } = createFilesystemConnector({
    root: sandboxRoot,
    holdThreshold: Number(process.env.AGENT_REWIND_FS_HOLD_THRESHOLD ?? 25),
  });
  await runtime.registerConnector(fsManifest, fsClient);

  const emailClient = new Client({ name: "agent-rewind-runtime-email", version: "0.1.0" });
  await emailClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(repoRoot, "packages/connectors/dist/email/main.js"),
        path.join(home, "email.sqlite"),
        String(sendWindowMs),
      ],
    }),
  );
  const { manifest: emailManifest } = createEmailConnector({
    holdThreshold: Number(process.env.AGENT_REWIND_EMAIL_HOLD_THRESHOLD ?? 250),
  });
  await runtime.registerConnector(emailManifest, emailClient);
  log("Downstream MCP servers up (filesystem + mock email)");
  if (runtime.isStopped()) {
    log("⛔ Kill switch is TRIPPED (persisted from a previous run) — side-effecting calls will be refused until resumed.");
  }

  const webDist = path.join(repoRoot, "packages/web/dist");
  const app = createApiServer(
    runtime,
    fs.existsSync(webDist) ? { staticDir: webDist } : {},
  );
  const httpServer = app.listen(port, "127.0.0.1", () => {
    log(`Timeline UI: http://localhost:${port}`);
  });
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    // Fail loudly: pointing the operator at a URL served by a different
    // runtime would wire STOP/Undo to the wrong journal.
    console.error(
      err.code === "EADDRINUSE"
        ? `[agent-rewind] FATAL: port ${port} already in use (another instance?).`
        : `[agent-rewind] FATAL: timeline server failed: ${err.message}`,
    );
    process.exit(1);
  });

  // Last: hand stdio to the MCP proxy. From here on, stdout is protocol.
  const proxy = createProxyServer(runtime);
  await proxy.connect(new StdioServerTransport());
  log("Agent Rewind proxy connected — intercepting.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
