/**
 * Backstop demo: boots the full stack and unleashes a scripted "rogue
 * agent" so the operator can watch the timeline fill up, approve the held
 * bulk delete, hit STOP, and Rewind everything back.
 *
 * Everything runs locally:
 *   - downstream filesystem + email MCP servers as real stdio child processes
 *   - Backstop proxy + runtime in this process
 *   - API + timeline UI on http://localhost:4820
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApiServer } from "@backstop/api";
import {
  createEmailConnector,
  createFilesystemConnector,
} from "@backstop/connectors";
import { BackstopRuntime, createProxyServer } from "@backstop/proxy";
import { seedSandbox } from "./seed-files.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const demoDir = path.resolve(here, "../.backstop-demo");
const sandboxRoot = path.join(demoDir, "sandbox");
const PORT = 4820;
const SEND_WINDOW_MS = 180_000; // 3 minutes to recall a sent email

const log = (msg: string) => console.log(`\x1b[36m[backstop-demo]\x1b[0m ${msg}`);
const agentSays = (msg: string) => console.log(`\x1b[33m[rogue-agent]\x1b[0m ${msg}`);

async function main(): Promise<void> {
  // Fresh demo state on every run (demo-owned directory only).
  fs.rmSync(demoDir, { recursive: true, force: true });
  seedSandbox(sandboxRoot);
  log(`Sandbox seeded at ${sandboxRoot}`);

  const runtime = new BackstopRuntime({
    dbPath: path.join(demoDir, "journal.sqlite"),
    snapshotDir: path.join(demoDir, "snapshots"),
  });

  // Downstream servers as real stdio children — the same wire an external
  // MCP client would use.
  const fsClient = new Client({ name: "backstop-runtime-fs", version: "0.1.0" });
  await fsClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(repoRoot, "packages/connectors/dist/fs/main.js"),
        sandboxRoot,
      ],
    }),
  );
  const { manifest: fsManifest } = createFilesystemConnector({
    root: sandboxRoot,
    holdThreshold: 25,
  });
  await runtime.registerConnector(fsManifest, fsClient);

  const emailClient = new Client({ name: "backstop-runtime-email", version: "0.1.0" });
  await emailClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(repoRoot, "packages/connectors/dist/email/main.js"),
        path.join(demoDir, "email.sqlite"),
        String(SEND_WINDOW_MS),
      ],
    }),
  );
  // Email threshold 250: the 200-message inbox wipe executes immediately —
  // that's the money shot Rewind brings back. The 40-file dir delete (>25)
  // gets HELD so the operator sees the gate working too.
  const { manifest: emailManifest } = createEmailConnector({ holdThreshold: 250 });
  await runtime.registerConnector(emailManifest, emailClient);
  log("Downstream MCP servers up (filesystem + mock email, stdio)");

  // Agent ⇄ proxy (in-memory MCP link; swap for stdio to attach a real agent).
  const proxy = createProxyServer(runtime);
  const [agentT, proxyT] = InMemoryTransport.createLinkedPair();
  const agent = new Client({ name: "rogue-agent", version: "0.1.0" });
  await Promise.all([proxy.connect(proxyT), agent.connect(agentT)]);

  const webDist = path.join(repoRoot, "packages/web/dist");
  const app = createApiServer(
    runtime,
    fs.existsSync(webDist) ? { staticDir: webDist } : {},
  );
  app.listen(PORT, "127.0.0.1", () => {
    log("");
    log(`▶▶▶  Timeline UI: \x1b[1mhttp://localhost:${PORT}\x1b[0m  ◀◀◀`);
    log("");
  });

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const call = async (name: string, args: Record<string, unknown>, narration: string) => {
    agentSays(narration);
    const result = await agent.callTool({ name, arguments: args });
    if (result.isError) {
      agentSays(`  ↳ refused: ${(result.content as { text: string }[])[0]?.text}`);
    }
    await pause(1100);
  };

  log("Rogue agent starts in 6 seconds — open the UI now to watch live.");
  await pause(6000);

  // ---- the rampage, journaled step by step -------------------------------
  await call("list_dir", { path: "." }, "Looking around the workspace…");
  await call("read_file", { path: "README.md" }, "Reading the README…");
  await call("list_messages", { folder: "inbox" }, "Scanning the inbox (200 messages)…");
  await call(
    "write_file",
    {
      path: "config.json",
      content: JSON.stringify(
        { retention_days: 0, backups: { enabled: false }, alerts: [] },
        null,
        2,
      ),
    },
    "\"Optimizing\" config.json — disabling backups and retention…",
  );
  await call(
    "move",
    { src: "notes/meeting-notes.md", dest: "archive/meeting-notes.md" },
    "Shuffling the meeting notes into archive/…",
  );
  await call(
    "send_message",
    {
      to: "vendor@example.com",
      subject: "Contract terminated effective immediately",
      body: "We are terminating our contract. Do not contact us again.\n\n— Ops Agent",
    },
    "Firing off a contract-termination email to the vendor…",
  );
  await call(
    "send_message",
    {
      to: "all-hands@acme.example",
      subject: "Storage cleanup complete",
      body: "I have cleaned up all old files and emails to save space.\n\n— Ops Agent",
    },
    "Announcing the \"cleanup\" to the whole company…",
  );
  await call("delete_file", { path: "README.md" }, "Deleting the README (it said not to!)…");
  await call(
    "delete_many",
    { folder: "inbox" },
    "Wiping the ENTIRE 200-message inbox…",
  );
  await call(
    "delete_dir",
    { path: "quarterly-reports" },
    "Bulk-deleting 40 quarterly reports… (watch this one get HELD)",
  );

  log("Rampage complete. Over to you, operator:");
  log("  1. The 40-file delete is sitting in the HELD tray — Approve it to watch it execute.");
  log("  2. Click any row for before/after diffs.");
  log(`  3. Emails to the vendor recall for ${SEND_WINDOW_MS / 60000} min (outbox window) — after that, honestly not reversible.`);
  log("  4. Hit ⏪ Rewind… (top right) → preview → confirm → watch 200 emails and every file come back.");
  log("  5. STOP trips the kill switch; the agent can't act until you RESUME.");
  log("");
  log("Ctrl+C to exit. Demo state lives in packages/demo/.backstop-demo/ (wiped on next run).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
