import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSmtpConnector,
  createSmtpMcpServer,
  createXConnector,
  createXMcpServer,
  type OutboundMail,
} from "@agentrewind/connectors";
import { AgentRewindRuntime } from "./runtime.js";
import { createProxyServer } from "./server.js";

/**
 * End-to-end contract for REAL outbound connectors (SMTP + X): with
 * holdThreshold 0, NOTHING goes out without an operator approval — and the
 * things that did go out are undone (X) or honestly not-reversible (email).
 */

let tmpDir: string;
let runtime: AgentRewindRuntime;
let agent: Client;
let delivered: OutboundMail[];
let tweetsDeleted: string[];
let postCalls: number;

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[])
    .map((c) => c.text)
    .join("\n");
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rewind-outbound-"));
  runtime = new AgentRewindRuntime({
    dbPath: path.join(tmpDir, "journal.sqlite"),
    snapshotDir: path.join(tmpDir, "snaps"),
  });

  delivered = [];
  const smtpServer = createSmtpMcpServer({
    from: "founder@moholo.example",
    deliver: async (mail) => {
      delivered.push(mail);
      return { messageId: "<e2e@test>" };
    },
  });
  const [smtpClientT, smtpServerT] = InMemoryTransport.createLinkedPair();
  const smtpDown = new Client({ name: "smtp-down", version: "0.1.0" });
  await Promise.all([smtpServer.connect(smtpServerT), smtpDown.connect(smtpClientT)]);
  await runtime.registerConnector(createSmtpConnector().manifest, smtpDown);

  tweetsDeleted = [];
  postCalls = 0;
  let nextId = 500;
  const { server: xServer } = createXMcpServer({
    credentials: { apiKey: "k", apiSecret: "ks", accessToken: "t", accessSecret: "ts" },
    baseUrl: "https://x.test",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        postCalls += 1;
        return Response.json({ data: { id: String(++nextId) } }, { status: 201 });
      }
      tweetsDeleted.push(String(input).split("/").pop()!);
      return Response.json({ data: { deleted: true } });
    }) as typeof fetch,
  });
  const [xClientT, xServerT] = InMemoryTransport.createLinkedPair();
  const xDown = new Client({ name: "x-down", version: "0.1.0" });
  await Promise.all([xServer.connect(xServerT), xDown.connect(xClientT)]);
  await runtime.registerConnector(createXConnector().manifest, xDown);

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

describe("real outbound connectors, end to end", () => {
  it("admin__delete_tweet is invisible to the agent", async () => {
    const { tools } = await agent.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("post_tweet");
    expect(names).toContain("send_email");
    expect(names).not.toContain("admin__delete_tweet");
  });

  it("send_email is HELD, executes only on approval, undo is not-reversible", async () => {
    const result = await agent.callTool({
      name: "send_email",
      arguments: { to: "a@b.co", subject: "Hi", body: "hello" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("held for human approval");
    expect(delivered).toHaveLength(0); // NOTHING left the building

    const held = runtime.journal.list().find((a) => a.status === "held")!;
    const outcome = await runtime.approveHeld(held.id);
    expect(outcome.action.status).toBe("executed");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.from).toBe("founder@moholo.example");

    const undo = await runtime.undoAction(held.id);
    expect(undo.outcome).toBe("not-reversible");
    expect(runtime.journal.get(held.id).status).toBe("executed"); // not faked as undone
  });

  it("post_tweet is HELD, executes on approval, undo deletes the real tweet", async () => {
    const result = await agent.callTool({
      name: "post_tweet",
      arguments: { text: "We are live!" },
    });
    expect(result.isError).toBe(true);
    expect(postCalls).toBe(0);

    const held = runtime.journal.list().find((a) => a.status === "held")!;
    const outcome = await runtime.approveHeld(held.id);
    expect(outcome.action.status).toBe("executed");
    expect(postCalls).toBe(1);
    expect(text({ content: outcome.content })).toContain("501");

    const undo = await runtime.undoAction(held.id);
    expect(undo.outcome).toBe("undone");
    expect(tweetsDeleted).toEqual(["501"]);
    expect(runtime.journal.get(held.id).status).toBe("undone");
  });

  it("rejecting a held post means the API is never touched", async () => {
    await agent.callTool({ name: "post_tweet", arguments: { text: "draft" } });
    const held = runtime.journal.list().find((a) => a.status === "held")!;
    runtime.rejectHeld(held.id);
    expect(postCalls).toBe(0);
    expect(runtime.journal.get(held.id).status).toBe("rejected");
  });

  it("kill switch blocks outbound even before the hold", async () => {
    runtime.stop();
    const result = await agent.callTool({
      name: "post_tweet",
      arguments: { text: "should never queue" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("kill switch");
    const rows = runtime.journal.list();
    expect(rows.find((a) => a.tool === "post_tweet")!.status).toBe("blocked-by-stop");
    runtime.resume();
  });
});
