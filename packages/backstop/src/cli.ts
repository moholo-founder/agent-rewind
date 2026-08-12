#!/usr/bin/env node
/**
 * backstop — flight recorder + undo button for AI agents, as one command.
 *
 *   backstop [serve]          MCP proxy over stdio + timeline UI (default)
 *   backstop fs-server <root>          (internal) downstream filesystem server
 *   backstop email-server <db> [ms]    (internal) downstream mock email server
 *
 * `serve` is what an MCP client launches:
 *
 *   { "mcpServers": { "backstop": { "command": "npx", "args": ["-y", "backstop-mcp"] } } }
 *
 * Configuration (env):
 *   BACKSTOP_HOME       state directory (default ~/.backstop)
 *   BACKSTOP_PORT       timeline UI port (default 4821)
 *   BACKSTOP_SANDBOX    filesystem sandbox root (default $BACKSTOP_HOME/sandbox,
 *                       seeded with a demo workspace if absent)
 *   BACKSTOP_SEND_WINDOW_MS         email recall window (default 180000)
 *   BACKSTOP_FS_HOLD_THRESHOLD      files (default 25)
 *   BACKSTOP_EMAIL_HOLD_THRESHOLD   messages (default 250)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApiServer } from "@backstop/api";
import {
  createEmailConnector,
  createEmailMcpServer,
  createFilesystemConnector,
  createFilesystemMcpServer,
  seedInbox,
} from "@backstop/connectors";
import { BackstopRuntime, createProxyServer } from "@backstop/proxy";
import { seedSandbox } from "./seed.js";

const selfScript = fileURLToPath(import.meta.url);
const log = (msg: string) => console.error(`[backstop] ${msg}`);

async function fsServerCmd(root: string): Promise<void> {
  const server = createFilesystemMcpServer(root);
  await server.connect(new StdioServerTransport());
}

async function emailServerCmd(dbPath: string, windowMs: number): Promise<void> {
  const { server, store } = createEmailMcpServer(dbPath, {
    deliveryWindowMs: windowMs,
  });
  seedInbox(store);
  const timer = setInterval(() => store.deliverDue(), 1000);
  timer.unref();
  await server.connect(new StdioServerTransport());
}

async function serveCmd(): Promise<void> {
  const home = process.env.BACKSTOP_HOME
    ? path.resolve(process.env.BACKSTOP_HOME)
    : path.join(os.homedir(), ".backstop");
  const sandboxRoot = process.env.BACKSTOP_SANDBOX
    ? path.resolve(process.env.BACKSTOP_SANDBOX)
    : path.join(home, "sandbox");
  const port = Number(process.env.BACKSTOP_PORT ?? 4821);
  const sendWindowMs = Number(process.env.BACKSTOP_SEND_WINDOW_MS ?? 180_000);

  if (!fs.existsSync(sandboxRoot)) {
    seedSandbox(sandboxRoot);
    log(`Seeded demo sandbox at ${sandboxRoot} (set BACKSTOP_SANDBOX to use your own)`);
  }

  const runtime = new BackstopRuntime({
    dbPath: path.join(home, "journal.sqlite"),
    snapshotDir: path.join(home, "snapshots"),
  });

  const fsClient = new Client({ name: "backstop-runtime-fs", version: "0.1.0" });
  await fsClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [selfScript, "fs-server", sandboxRoot],
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
      args: [selfScript, "email-server", path.join(home, "email.sqlite"), String(sendWindowMs)],
    }),
  );
  const { manifest: emailManifest } = createEmailConnector({
    holdThreshold: Number(process.env.BACKSTOP_EMAIL_HOLD_THRESHOLD ?? 250),
  });
  await runtime.registerConnector(emailManifest, emailClient);
  log("Downstream MCP servers up (filesystem + mock email)");
  if (runtime.isStopped()) {
    log("⛔ Kill switch is TRIPPED (persisted) — side-effecting calls refused until resumed.");
  }

  // The UI ships inside the package, next to dist/.
  const webDir = path.resolve(path.dirname(selfScript), "../web");
  const app = createApiServer(
    runtime,
    fs.existsSync(webDir) ? { staticDir: webDir } : {},
  );
  app.listen(port, "127.0.0.1", () => {
    log(`Timeline UI: http://localhost:${port}`);
  });

  const proxy = createProxyServer(runtime);
  await proxy.connect(new StdioServerTransport());
  log("Backstop proxy connected — intercepting.");
}

const [, , cmd, ...rest] = process.argv;
try {
  switch (cmd ?? "serve") {
    case "serve":
      await serveCmd();
      break;
    case "fs-server": {
      const root = rest[0];
      if (!root) throw new Error("Usage: backstop fs-server <sandbox-root>");
      await fsServerCmd(root);
      break;
    }
    case "email-server": {
      const db = rest[0];
      if (!db) throw new Error("Usage: backstop email-server <db-path> [windowMs]");
      await emailServerCmd(db, rest[1] ? Number(rest[1]) : 180_000);
      break;
    }
    default:
      console.error(`Unknown command "${cmd}". Commands: serve (default), fs-server, email-server`);
      process.exit(1);
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
