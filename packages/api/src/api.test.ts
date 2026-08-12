import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEmailConnector,
  createEmailMcpServer,
  createFilesystemConnector,
  createFilesystemMcpServer,
  seedInbox,
  type EmailStore,
} from "@backstop/connectors";
import { BackstopRuntime, createProxyServer } from "@backstop/proxy";
import { createApiServer } from "./server.js";

/**
 * API tests against a full live runtime: real MCP servers for filesystem
 * and email behind the proxy, real HTTP in front.
 */

let tmpDir: string;
let root: string;
let runtime: BackstopRuntime;
let agent: Client;
let emailStore: EmailStore;
let httpServer: Server;
let base: string;

async function api(pathname: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backstop-api-"));
  root = path.join(tmpDir, "sandbox");
  fs.mkdirSync(root);

  runtime = new BackstopRuntime({
    dbPath: path.join(tmpDir, "journal.sqlite"),
    snapshotDir: path.join(tmpDir, "snaps"),
  });

  // filesystem downstream
  const fsServer = createFilesystemMcpServer(root);
  const [fsClientT, fsServerT] = InMemoryTransport.createLinkedPair();
  const fsClient = new Client({ name: "rt-fs", version: "0" });
  await Promise.all([fsServer.connect(fsServerT), fsClient.connect(fsClientT)]);
  const { manifest: fsManifest } = createFilesystemConnector({ root, holdThreshold: 25 });
  await runtime.registerConnector(fsManifest, fsClient);

  // email downstream
  const email = createEmailMcpServer(path.join(tmpDir, "email.sqlite"), {
    deliveryWindowMs: 60_000,
  });
  emailStore = email.store;
  seedInbox(email.store, 200);
  const [emClientT, emServerT] = InMemoryTransport.createLinkedPair();
  const emClient = new Client({ name: "rt-email", version: "0" });
  await Promise.all([email.server.connect(emServerT), emClient.connect(emClientT)]);
  const { manifest: emManifest } = createEmailConnector({ holdThreshold: 250 });
  await runtime.registerConnector(emManifest, emClient);

  // agent
  const proxy = createProxyServer(runtime);
  const [agentT, proxyT] = InMemoryTransport.createLinkedPair();
  agent = new Client({ name: "api-test-agent", version: "0" });
  await Promise.all([proxy.connect(proxyT), agent.connect(agentT)]);

  // http
  const app = createApiServer(runtime);
  await new Promise<void>((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = httpServer.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await agent.close().catch(() => {});
  await runtime.close();
  emailStore.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("API", () => {
  it("GET /api/state and /api/timeline reflect live activity", async () => {
    await agent.callTool({ name: "list_messages", arguments: { folder: "inbox" } });
    const state = await api("/api/state");
    expect(state.status).toBe(200);
    expect((state.body as { stopped: boolean }).stopped).toBe(false);

    const timeline = await api("/api/timeline");
    const t = timeline.body as { actions: { tool: string }[]; rewinds: unknown[] };
    expect(t.actions[0]!.tool).toBe("list_messages");
  });

  it("SSE /api/events streams live actions", async () => {
    const controller = new AbortController();
    const resPromise = fetch(`${base}/api/events`, { signal: controller.signal });
    const res = await resPromise;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // hello event first
    let buf = decoder.decode((await reader.read()).value);
    expect(buf).toContain('"type":"hello"');

    await agent.callTool({
      name: "write_file",
      arguments: { path: "sse.txt", content: "ping" },
    });
    buf = "";
    while (!buf.includes("write_file")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
    }
    expect(buf).toContain('"type":"action"');
    expect(buf).toContain("write_file");
    controller.abort();
  });

  it("POST /api/undo/:id restores a deleted file", async () => {
    fs.writeFileSync(path.join(root, "doc.txt"), "original");
    await agent.callTool({ name: "delete_file", arguments: { path: "doc.txt" } });
    const actionId = runtime.journal.list()[0]!.id;

    const undo = await api(`/api/undo/${actionId}`, { method: "POST" });
    expect(undo.status).toBe(200);
    expect((undo.body as { result: { outcome: string } }).result.outcome).toBe("undone");
    expect(fs.readFileSync(path.join(root, "doc.txt"), "utf8")).toBe("original");
  });

  it("GET /api/actions/:id returns a diff-ready pre-state", async () => {
    fs.writeFileSync(path.join(root, "diff.txt"), "before-content");
    await agent.callTool({
      name: "write_file",
      arguments: { path: "diff.txt", content: "after-content" },
    });
    const actionId = runtime.journal.list()[0]!.id;
    const detail = await api(`/api/actions/${actionId}`);
    const body = detail.body as {
      action: { argsRedacted: { content: string } };
      preState: { kind: string; content: string };
    };
    expect(body.preState.kind).toBe("file");
    expect(body.preState.content).toBe("before-content");
    expect(body.action.argsRedacted.content).toBe("after-content");
  });

  it("stop/resume gate the agent through the API", async () => {
    await api("/api/stop", { method: "POST" });
    const blocked = await agent.callTool({
      name: "write_file",
      arguments: { path: "no.txt", content: "x" },
    });
    expect(blocked.isError).toBe(true);
    expect((await api("/api/state")).body).toMatchObject({ stopped: true });

    await api("/api/resume", { method: "POST" });
    const ok = await agent.callTool({
      name: "write_file",
      arguments: { path: "yes.txt", content: "x" },
    });
    expect(ok.isError).toBeFalsy();
  });

  it("hold approve/reject via the API", async () => {
    fs.mkdirSync(path.join(root, "bulk"));
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, "bulk", `${i}.txt`), "x");
    await agent.callTool({ name: "delete_dir", arguments: { path: "bulk" } });
    const held = runtime.journal.listHeld()[0]!;

    const approved = await api(`/api/hold/${held.id}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);
    expect((approved.body as { action: { status: string } }).action.status).toBe("executed");
    expect(fs.existsSync(path.join(root, "bulk"))).toBe(false);

    // approving again → 400
    const again = await api(`/api/hold/${held.id}/approve`, { method: "POST" });
    expect(again.status).toBe(400);
  });

  it("rewind preview + rewind returns an honest report including an induced undo failure", async () => {
    const anchor = new Date().toISOString();

    // Action 1: email bulk delete (will undo cleanly).
    await agent.callTool({ name: "delete_many", arguments: { folder: "inbox" } });
    expect(emailStore.count("inbox")).toBe(0);

    // Action 2: file delete whose snapshot we then destroy (undo must fail).
    fs.writeFileSync(path.join(root, "doomed.txt"), "cannot come back");
    await agent.callTool({ name: "delete_file", arguments: { path: "doomed.txt" } });
    const doomed = runtime.journal.list()[0]!;
    const pre = runtime.snapshots.getRecord<{ contentRef: string }>(doomed.preStateRef!);
    const blobPath = path.join(tmpDir, "snaps", pre.contentRef.slice(0, 2), pre.contentRef);
    fs.rmSync(blobPath); // sabotage

    const preview = await api(`/api/rewind/preview?to=${encodeURIComponent(anchor)}`);
    expect((preview.body as { actions: unknown[] }).actions).toHaveLength(2);

    const rewound = await api("/api/rewind", {
      method: "POST",
      body: JSON.stringify({ toTimestamp: anchor }),
    });
    const report = (rewound.body as { report: { fullyRestored: boolean; outcomes: { tool: string; outcome: string }[] } }).report;

    // Honest: emails came back, the sabotaged file did not, and the report says so.
    expect(report.fullyRestored).toBe(false);
    expect(report.outcomes.find((o) => o.tool === "delete_many")?.outcome).toBe("undone");
    expect(report.outcomes.find((o) => o.tool === "delete_file")?.outcome).toBe("failed");
    expect(emailStore.count("inbox")).toBe(200);
    expect(fs.existsSync(path.join(root, "doomed.txt"))).toBe(false);
    expect(runtime.journal.get(doomed.id).status).toBe("undo-failed");
  });

  it("404s on unknown action, 400 on bad rewind body", async () => {
    expect((await api("/api/actions/nope")).status).toBe(404);
    expect((await api("/api/rewind", { method: "POST", body: "{}" })).status).toBe(400);
  });
});
