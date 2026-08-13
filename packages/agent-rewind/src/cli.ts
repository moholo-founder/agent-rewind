#!/usr/bin/env node
/**
 * agent-rewind — flight recorder + undo button for AI agents, as one command.
 *
 *   agent-rewind [serve]          MCP proxy over stdio + timeline UI (default)
 *   agent-rewind ui               timeline UI + undo only (for hook-captured sessions)
 *   agent-rewind hook             (internal) Claude Code PreToolUse/PostToolUse hook
 *   agent-rewind hooks install [dir]   wire the hooks into a project's .claude/settings.json
 *   agent-rewind fs-server <root>          (internal) downstream filesystem server
 *   agent-rewind email-server <db> [ms]    (internal) downstream mock email server
 *
 * `serve` is what an MCP client launches:
 *
 *   { "mcpServers": { "agent-rewind": { "command": "npx", "args": ["-y", "agent-rewind"] } } }
 *
 * Configuration (env):
 *   AGENT_REWIND_HOME       state directory (default ~/.agent-rewind)
 *   AGENT_REWIND_PORT       timeline UI port (default 4821)
 *   AGENT_REWIND_SANDBOX    filesystem sandbox root (default $AGENT_REWIND_HOME/sandbox,
 *                       seeded with a demo workspace if absent)
 *   AGENT_REWIND_SEND_WINDOW_MS         email recall window (default 180000)
 *   AGENT_REWIND_FS_HOLD_THRESHOLD      files (default 25)
 *   AGENT_REWIND_EMAIL_HOLD_THRESHOLD   messages (default 250)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApiServer } from "@agentrewind/api";
import {
  createEmailConnector,
  createEmailMcpServer,
  createFilesystemConnector,
  createFilesystemMcpServer,
  seedInbox,
} from "@agentrewind/connectors";
import { AgentRewindRuntime, createProxyServer } from "@agentrewind/proxy";
import { seedDemoSandbox } from "@agentrewind/connectors";
import { runHook, type HookInput } from "./hooks.js";

const selfScript = fileURLToPath(import.meta.url);
const log = (msg: string) => console.error(`[agent-rewind] ${msg}`);

function resolveHome(): string {
  return process.env.AGENT_REWIND_HOME
    ? path.resolve(process.env.AGENT_REWIND_HOME)
    : path.join(os.homedir(), ".agent-rewind");
}

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
  const home = process.env.AGENT_REWIND_HOME
    ? path.resolve(process.env.AGENT_REWIND_HOME)
    : path.join(os.homedir(), ".agent-rewind");
  const sandboxRoot = process.env.AGENT_REWIND_SANDBOX
    ? path.resolve(process.env.AGENT_REWIND_SANDBOX)
    : path.join(home, "sandbox");
  const port = Number(process.env.AGENT_REWIND_PORT ?? 4821);
  const sendWindowMs = Number(process.env.AGENT_REWIND_SEND_WINDOW_MS ?? 180_000);

  if (!fs.existsSync(sandboxRoot)) {
    if (process.env.AGENT_REWIND_SANDBOX) {
      // The user pointed at their OWN sandbox: create it empty. Demo CSVs
      // belong only in the default demo sandbox.
      fs.mkdirSync(sandboxRoot, { recursive: true });
      log(`Created sandbox at ${sandboxRoot}`);
    } else {
      seedDemoSandbox(sandboxRoot);
      log(`Seeded demo sandbox at ${sandboxRoot} (set AGENT_REWIND_SANDBOX to use your own)`);
    }
  }

  const runtime = new AgentRewindRuntime({
    dbPath: path.join(home, "journal.sqlite"),
    snapshotDir: path.join(home, "snapshots"),
  });

  const fsClient = new Client({ name: "agent-rewind-runtime-fs", version: "0.1.0" });
  await fsClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [selfScript, "fs-server", sandboxRoot],
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
      args: [selfScript, "email-server", path.join(home, "email.sqlite"), String(sendWindowMs)],
    }),
  );
  const { manifest: emailManifest } = createEmailConnector({
    holdThreshold: Number(process.env.AGENT_REWIND_EMAIL_HOLD_THRESHOLD ?? 250),
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
  const server = app.listen(port, "127.0.0.1", () => {
    log(`Timeline UI: http://localhost:${port}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    // Fail loudly: silently pointing the operator at a URL served by a
    // DIFFERENT runtime would wire STOP/Undo to the wrong journal.
    if (err.code === "EADDRINUSE") {
      log(`FATAL: port ${port} is already in use (another Agent Rewind instance?). Set AGENT_REWIND_PORT to run side by side.`);
    } else {
      log(`FATAL: timeline server failed: ${err.message}`);
    }
    process.exit(1);
  });

  const proxy = createProxyServer(runtime);
  await proxy.connect(new StdioServerTransport());
  log("Agent Rewind proxy connected — intercepting.");
}

/** Timeline UI + undo over the shared journal — no MCP proxy. This is the
 *  operator console for hook-captured (native Claude Code) sessions. */
async function uiCmd(): Promise<void> {
  const home = resolveHome();
  const port = Number(process.env.AGENT_REWIND_PORT ?? 4821);
  const runtime = new AgentRewindRuntime({
    dbPath: path.join(home, "journal.sqlite"),
    snapshotDir: path.join(home, "snapshots"),
  });
  const webDir = path.resolve(path.dirname(selfScript), "../web");
  const app = createApiServer(
    runtime,
    fs.existsSync(webDir) ? { staticDir: webDir } : {},
  );
  const server = app.listen(port, "127.0.0.1", () => {
    log(`Timeline UI (hooks mode): http://localhost:${port}`);
    log(`Journal: ${path.join(home, "journal.sqlite")}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    log(
      err.code === "EADDRINUSE"
        ? `FATAL: port ${port} already in use. Set AGENT_REWIND_PORT to run side by side.`
        : `FATAL: timeline server failed: ${err.message}`,
    );
    process.exit(1);
  });
}

/** Read the Claude Code hook payload from stdin, run the hook, reply. */
async function hookCmd(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let input: HookInput;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput;
  } catch {
    // Unparseable payload: never break the user's session over it.
    process.exit(0);
  }
  const result = runHook(input, { home: resolveHome() });
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}

/** Merge our PreToolUse/PostToolUse hooks into .claude/settings.json. */
function hooksInstallCmd(projectDir: string): void {
  const settingsPath = path.join(projectDir, ".claude", "settings.json");
  const command = `"${process.execPath}" "${selfScript}" hook`;
  const matcher = "Bash|Edit|Write|MultiEdit|NotebookEdit";

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  }
  const hooks = (settings.hooks ?? {}) as Record<
    string,
    { matcher?: string; hooks: { type: string; command: string }[] }[]
  >;
  for (const event of ["PreToolUse", "PostToolUse"]) {
    const entries = hooks[event] ?? [];
    const already = entries.some((e) =>
      e.hooks?.some((h) => h.command.includes("agent-rewind") || h.command === command),
    );
    if (!already) {
      entries.push({ matcher, hooks: [{ type: "command", command }] });
    }
    hooks[event] = entries;
  }
  settings.hooks = hooks;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  log(`Hooks installed in ${settingsPath}`);
  log(`Journal: ${path.join(resolveHome(), "journal.sqlite")}`);
  log("New Claude Code sessions in this project are now flight-recorded:");
  log("  - every Bash/Edit/Write call journaled (intent + outcome)");
  log("  - file edits snapshotted before they land → undoable from the UI");
  log("  - dangerous shell patterns escalate to a permission prompt");
  log("  - the STOP switch refuses ALL of them until you resume");
  log("Operator console: agent-rewind ui   (http://localhost:4821)");
}

const [, , cmd, ...rest] = process.argv;
try {
  switch (cmd ?? "serve") {
    case "serve":
      await serveCmd();
      break;
    case "ui":
      await uiCmd();
      break;
    case "hook":
      await hookCmd();
      break;
    case "hooks": {
      if (rest[0] !== "install") {
        console.error("Usage: agent-rewind hooks install [project-dir]");
        process.exit(1);
      }
      hooksInstallCmd(path.resolve(rest[1] ?? process.cwd()));
      break;
    }
    case "fs-server": {
      const root = rest[0];
      if (!root) throw new Error("Usage: agent-rewind fs-server <sandbox-root>");
      await fsServerCmd(root);
      break;
    }
    case "email-server": {
      const db = rest[0];
      if (!db) throw new Error("Usage: agent-rewind email-server <db-path> [windowMs]");
      await emailServerCmd(db, rest[1] ? Number(rest[1]) : 180_000);
      break;
    }
    default:
      console.error(
        `Unknown command "${cmd}". Commands: serve (default), ui, hook, hooks install, fs-server, email-server`,
      );
      process.exit(1);
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
