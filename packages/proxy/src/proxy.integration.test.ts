import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFilesystemConnector,
  createFilesystemMcpServer,
} from "@backstop/connectors";
import { BackstopRuntime } from "./runtime.js";
import { createProxyServer } from "./server.js";

/**
 * Integration tests through the real MCP SDK (no mocks of it):
 *   agent Client ⇄ Backstop proxy Server ⇄ downstream client ⇄ fs McpServer
 * All four endpoints speak actual MCP over linked transports.
 */

let tmpDir: string;
let root: string;
let runtime: BackstopRuntime;
let agent: Client;

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[])
    .map((c) => c.text)
    .join("\n");
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backstop-proxy-"));
  root = path.join(tmpDir, "sandbox");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "hello.txt"), "hello world");

  runtime = new BackstopRuntime({
    dbPath: path.join(tmpDir, "journal.sqlite"),
    snapshotDir: path.join(tmpDir, "snaps"),
  });

  // Downstream: real fs MCP server over an in-memory MCP link.
  const fsServer = createFilesystemMcpServer(root);
  const [downClientT, downServerT] = InMemoryTransport.createLinkedPair();
  const downstream = new Client({ name: "backstop-runtime", version: "0.1.0" });
  await Promise.all([
    fsServer.connect(downServerT),
    downstream.connect(downClientT),
  ]);

  const { manifest } = createFilesystemConnector({ root, holdThreshold: 25 });
  await runtime.registerConnector(manifest, downstream);

  // Agent side: real MCP client against the proxy server.
  const proxy = createProxyServer(runtime);
  const [agentT, proxyT] = InMemoryTransport.createLinkedPair();
  agent = new Client({ name: "test-agent", version: "0.0.1" });
  await Promise.all([proxy.connect(proxyT), agent.connect(agentT)]);
});

afterEach(async () => {
  await agent.close().catch(() => {});
  await runtime.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("proxy end-to-end", () => {
  it("exposes downstream tools to the agent", async () => {
    const { tools } = await agent.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "delete_dir",
      "delete_file",
      "list_dir",
      "move",
      "read_file",
      "write_file",
    ]);
  });

  it("passes reads through untouched and journals them without snapshots", async () => {
    const result = await agent.callTool({
      name: "read_file",
      arguments: { path: "hello.txt" },
    });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe("hello world");

    const entry = runtime.journal.list()[0]!;
    expect(entry.tool).toBe("read_file");
    expect(entry.class).toBe("read");
    expect(entry.status).toBe("executed");
    expect(entry.preStateRef).toBeNull();
  });

  it("snapshots + journals a delete, and undo restores the file", async () => {
    const result = await agent.callTool({
      name: "delete_file",
      arguments: { path: "hello.txt" },
    });
    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(path.join(root, "hello.txt"))).toBe(false);

    const entry = runtime.journal.list()[0]!;
    expect(entry.status).toBe("executed");
    expect(entry.class).toBe("destructive");
    expect(entry.preStateRef).not.toBeNull();
    expect(runtime.snapshots.has(entry.preStateRef!)).toBe(true);

    const undo = await runtime.undoAction(entry.id);
    expect(undo.outcome).toBe("undone");
    expect(fs.readFileSync(path.join(root, "hello.txt"), "utf8")).toBe("hello world");
    expect(runtime.journal.get(entry.id).status).toBe("undone");
  });

  it("STOP blocks side-effecting calls but not reads; resume re-enables", async () => {
    runtime.stop();

    const blocked = await agent.callTool({
      name: "write_file",
      arguments: { path: "x.txt", content: "nope" },
    });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain("kill switch");
    expect(fs.existsSync(path.join(root, "x.txt"))).toBe(false);
    expect(runtime.journal.list()[0]!.status).toBe("blocked-by-stop");

    const read = await agent.callTool({
      name: "read_file",
      arguments: { path: "hello.txt" },
    });
    expect(read.isError).toBeFalsy();
    expect(text(read)).toBe("hello world");

    runtime.resume();
    const ok = await agent.callTool({
      name: "write_file",
      arguments: { path: "x.txt", content: "yes" },
    });
    expect(ok.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(root, "x.txt"), "utf8")).toBe("yes");
  });

  it("holds a blast-radius breach; approval executes it; rewind restores", async () => {
    const anchor = new Date().toISOString();
    fs.mkdirSync(path.join(root, "big"));
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(root, "big", `f${i}.txt`), `content-${i}`);
    }

    const heldResult = await agent.callTool({
      name: "delete_dir",
      arguments: { path: "big" },
    });
    expect(heldResult.isError).toBe(true);
    expect(text(heldResult)).toContain("held for human approval");
    expect(fs.existsSync(path.join(root, "big"))).toBe(true); // did NOT execute

    const held = runtime.journal.listHeld();
    expect(held).toHaveLength(1);
    expect(held[0]!.blastRadius).toBe(30);

    const outcome = await runtime.approveHeld(held[0]!.id);
    expect(outcome.action.status).toBe("executed");
    expect(fs.existsSync(path.join(root, "big"))).toBe(false);

    const report = await runtime.rewind(anchor);
    expect(report.fullyRestored).toBe(true);
    expect(fs.readFileSync(path.join(root, "big/f17.txt"), "utf8")).toBe("content-17");
  });

  it("rejecting a held action never executes it", async () => {
    fs.mkdirSync(path.join(root, "big2"));
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(root, "big2", `f${i}.txt`), "x");
    }
    await agent.callTool({ name: "delete_dir", arguments: { path: "big2" } });
    const held = runtime.journal.listHeld()[0]!;
    const rejected = runtime.rejectHeld(held.id);
    expect(rejected.status).toBe("rejected");
    expect(fs.existsSync(path.join(root, "big2"))).toBe(true);
    await expect(runtime.approveHeld(held.id)).rejects.toThrow(/not held/);
  });

  it("refuses tools no connector exposes", async () => {
    const result = await agent.callTool({
      name: "format_disk",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Unknown tool");
  });

  it("journals redacted args only", async () => {
    await agent.callTool({
      name: "write_file",
      arguments: { path: "creds.txt", content: "hunter2" },
    });
    // args are journaled; a hypothetical secret-named field must be redacted
    await agent.callTool({
      name: "write_file",
      arguments: { path: "t.txt", content: "x", api_token: "sk-secret-123" } as never,
    });
    const entries = runtime.journal.list();
    const withSecret = JSON.stringify(entries);
    expect(withSecret).not.toContain("sk-secret-123");
  });

  it("multi-step rewind unwinds in LIFO order across mixed operations", async () => {
    const anchor = new Date().toISOString();
    await agent.callTool({
      name: "write_file",
      arguments: { path: "a.txt", content: "v1" },
    });
    await agent.callTool({
      name: "write_file",
      arguments: { path: "a.txt", content: "v2" },
    });
    await agent.callTool({
      name: "move",
      arguments: { src: "a.txt", dest: "b.txt" },
    });
    await agent.callTool({ name: "delete_file", arguments: { path: "b.txt" } });

    const report = await runtime.rewind(anchor);
    expect(report.fullyRestored).toBe(true);
    expect(report.outcomes.map((o) => o.tool)).toEqual([
      "delete_file",
      "move",
      "write_file",
      "write_file",
    ]);
    // Original world: a.txt never existed before the anchor.
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(fs.existsSync(path.join(root, "b.txt"))).toBe(false);
  });
});
