import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Journal,
  SnapshotStore,
  type ActionRecord,
  type CompensatorContext,
} from "@agentrewind/core";
import { createXConnector } from "./connector.js";
import type { OAuth1Credentials } from "./oauth1.js";
import { PostLog } from "./postlog.js";
import { createXMcpServer } from "./server.js";

const CREDS: OAuth1Credentials = {
  apiKey: "k",
  apiSecret: "ks",
  accessToken: "t",
  accessSecret: "ts",
};

/** Fake X API: records requests, hands out sequential tweet ids. */
function fakeXApi() {
  const requests: { method: string; url: string; auth: string; body?: unknown }[] = [];
  const deleted: string[] = [];
  let nextId = 1000;
  let failWith: { status: number; body: string } | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const auth = String((init?.headers as Record<string, string>).authorization ?? "");
    requests.push({
      method,
      url,
      auth,
      ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
    });
    if (failWith) {
      return new Response(failWith.body, { status: failWith.status });
    }
    if (method === "POST") {
      return Response.json({ data: { id: String(++nextId) } }, { status: 201 });
    }
    const id = url.split("/").pop()!;
    deleted.push(id);
    return Response.json({ data: { deleted: true } });
  }) as typeof fetch;
  return {
    requests,
    deleted,
    fetchImpl,
    fail(status: number, body: string) {
      failWith = { status, body };
    },
    ok() {
      failWith = null;
    },
  };
}

let tmpDir: string;
let journal: Journal;
let ctx: CompensatorContext;
let client: Client;
let api: ReturnType<typeof fakeXApi>;

async function connect(logPath?: string): Promise<void> {
  const { server } = createXMcpServer({
    credentials: CREDS,
    baseUrl: "https://x.test",
    fetchImpl: api.fetchImpl,
    ...(logPath ? { logPath } : {}),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "x-test", version: "0.0.1" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  ctx = {
    snapshots: new SnapshotStore(path.join(tmpDir, "snaps"), journal),
    callDownstream: async (tool, args) => {
      const result = await client.callTool({ name: tool, arguments: args });
      if (result.isError) {
        throw new Error(
          (result.content as { text?: string }[]).map((c) => c.text).join("\n"),
        );
      }
      return result;
    },
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rewind-x-"));
  journal = new Journal(path.join(tmpDir, "journal.sqlite"));
  api = fakeXApi();
  await connect();
});

afterEach(async () => {
  await client.close().catch(() => {});
  journal.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function entryFor(preStateRef: string | null): ActionRecord {
  return {
    id: "test-action",
    ts: new Date().toISOString(),
    executedTs: new Date().toISOString(),
    sessionId: "t",
    connector: "x",
    tool: "post_tweet",
    argsRedacted: {},
    class: "reversible",
    riskScore: 0.7,
    blastRadius: 1,
    preStateRef,
    status: "executed",
    resultSummary: null,
    causedBy: null,
  };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { text: string }[]).map((c) => c.text).join("\n");
}

describe("x connector", () => {
  it("post_tweet calls the v2 endpoint with an OAuth1 header and returns the id", async () => {
    const result = await client.callTool({
      name: "post_tweet",
      arguments: { text: "hello world" },
    });
    const payload = JSON.parse(textOf(result)) as { id: string; url: string };
    expect(payload.id).toBe("1001");
    expect(payload.url).toContain("1001");
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]!.url).toBe("https://x.test/2/tweets");
    expect(api.requests[0]!.body).toEqual({ text: "hello world" });
    expect(api.requests[0]!.auth).toMatch(/^OAuth oauth_consumer_key="k"/);
  });

  it("post → undo deletes the tweet through admin__delete_tweet", async () => {
    const { manifest } = createXConnector();
    const cap = manifest.tools.post_tweet!.compensator!;
    const args = { text: "launch day!" };

    const ref = await cap.capture(args, ctx);
    await client.callTool({ name: "post_tweet", arguments: args });

    const result = await cap.undo(entryFor(ref), ctx);
    expect(result.outcome).toBe("undone");
    expect(result.detail).toContain("1001");
    expect(api.deleted).toEqual(["1001"]);
  });

  it("two identical posts each undo THEIR OWN tweet", async () => {
    const { manifest } = createXConnector();
    const cap = manifest.tools.post_tweet!.compensator!;
    const args = { text: "same text" };

    const refA = await cap.capture(args, ctx);
    await client.callTool({ name: "post_tweet", arguments: args }); // id 1001
    await new Promise((r) => setTimeout(r, 5));
    const refB = await cap.capture(args, ctx);
    await client.callTool({ name: "post_tweet", arguments: args }); // id 1002

    // Undo B first: must delete 1002 (its own), not 1001.
    const undoB = await cap.undo(entryFor(refB), ctx);
    expect(undoB.outcome).toBe("undone");
    expect(api.deleted).toEqual(["1002"]);

    const undoA = await cap.undo(entryFor(refA), ctx);
    expect(undoA.outcome).toBe("undone");
    expect(api.deleted).toEqual(["1002", "1001"]);
  });

  it("undo with no matching post reports failure honestly", async () => {
    const { manifest } = createXConnector();
    const cap = manifest.tools.post_tweet!.compensator!;
    const ref = await cap.capture({ text: "never actually posted" }, ctx);
    const result = await cap.undo(entryFor(ref), ctx);
    expect(result.outcome).toBe("failed");
    expect(result.detail).toMatch(/no matching tweet/i);
    expect(api.deleted).toEqual([]);
  });

  it("API failure on post surfaces as a tool error, nothing logged", async () => {
    api.fail(403, '{"detail":"Forbidden"}');
    const result = await client.callTool({
      name: "post_tweet",
      arguments: { text: "nope" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("403");
  });

  it("a 404 on delete counts as deleted (the tweet is gone either way)", async () => {
    await client.callTool({ name: "post_tweet", arguments: { text: "gone" } });
    api.fail(404, "not found");
    const result = await client.callTool({
      name: "admin__delete_tweet",
      arguments: { text: "gone" },
    });
    const payload = JSON.parse(textOf(result)) as { deleted: boolean; reason: string };
    expect(payload.deleted).toBe(true);
    expect(payload.reason).toMatch(/already gone/i);
  });

  it("post log persists across a server restart, so undo survives it", async () => {
    const logPath = path.join(tmpDir, "posts.jsonl");
    await client.close();
    await connect(logPath);

    const { manifest } = createXConnector();
    const cap = manifest.tools.post_tweet!.compensator!;
    const args = { text: "durable" };
    const ref = await cap.capture(args, ctx);
    await client.callTool({ name: "post_tweet", arguments: args });

    // Simulate a restart: fresh server + client over the same log file.
    await client.close();
    await connect(logPath);

    const result = await cap.undo(entryFor(ref), ctx);
    expect(result.outcome).toBe("undone");
    expect(api.deleted).toEqual(["1001"]);
  });

  it("post log tolerates a torn trailing line", () => {
    const logPath = path.join(tmpDir, "torn.jsonl");
    fs.writeFileSync(
      logPath,
      `${JSON.stringify({ op: "post", id: "1", text: "ok", ts: "2026-01-01T00:00:00Z" })}\n{"op":"po`,
    );
    const log = new PostLog(logPath);
    expect(log.find("ok")?.id).toBe("1");
  });
});
