#!/usr/bin/env node
/**
 * Backstop live proxy over stdio — the entry point a real MCP client
 * (Claude Code, Claude Desktop/Cowork, anything MCP) launches.
 *
 *   node packages/demo/dist/serve.js
 *
 * stdin/stdout speak MCP to the agent; ALL logging goes to stderr. The
 * timeline API + UI come up on BACKSTOP_PORT (default 4821) so a human can
 * watch/undo/stop while the agent works. State persists across runs in
 * BACKSTOP_HOME (default packages/demo/.backstop-live) — including the STOP
 * flag: if you tripped the kill switch, a freshly launched proxy is still
 * stopped until a human resumes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApiServer } from "@backstop/api";
import {
  createEmailConnector,
  createFilesystemConnector,
} from "@backstop/connectors";
import { BackstopRuntime, createProxyServer } from "@backstop/proxy";
import { seedSandbox } from "./seed-files.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const home = process.env.BACKSTOP_HOME
  ? path.resolve(process.env.BACKSTOP_HOME)
  : path.resolve(here, "../.backstop-live");
const sandboxRoot = path.join(home, "sandbox");
const port = Number(process.env.BACKSTOP_PORT ?? 4821);
const sendWindowMs = Number(process.env.BACKSTOP_SEND_WINDOW_MS ?? 180_000);

const log = (msg: string) => console.error(`[backstop] ${msg}`);

async function main(): Promise<void> {
  if (!fs.existsSync(sandboxRoot)) {
    seedSandbox(sandboxRoot);
    log(`Seeded sandbox at ${sandboxRoot}`);
  }

  const runtime = new BackstopRuntime({
    dbPath: path.join(home, "journal.sqlite"),
    snapshotDir: path.join(home, "snapshots"),
  });

  const fsClient = new Client({ name: "backstop-runtime-fs", version: "0.1.0" });
  await fsClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, "packages/connectors/dist/fs/main.js"), sandboxRoot],
    }),
  );
  const { manifest: fsManifest } = createFilesystemConnector({
    root: sandboxRoot,
    holdThreshold: Number(process.env.BACKSTOP_FS_HOLD_THRESHOLD ?? 25),
  });
  await runtime.registerConnector(fsManifest, fsClient);

  const emailClient = new Client({ name: "backstop-runtime-email", version: "0.1.0" });
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
    holdThreshold: Number(process.env.BACKSTOP_EMAIL_HOLD_THRESHOLD ?? 250),
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
  app.listen(port, "127.0.0.1", () => {
    log(`Timeline UI: http://localhost:${port}`);
  });

  // Last: hand stdio to the MCP proxy. From here on, stdout is protocol.
  const proxy = createProxyServer(runtime);
  await proxy.connect(new StdioServerTransport());
  log("Backstop proxy connected — intercepting.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
