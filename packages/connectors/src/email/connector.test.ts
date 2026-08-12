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
import { createEmailConnector } from "./connector.js";
import { seedInbox } from "./seed.js";
import { createEmailMcpServer } from "./server.js";
import type { EmailStore } from "./store.js";

let tmpDir: string;
let journal: Journal;
let store: EmailStore;
let client: Client;
let ctx: CompensatorContext;

const WINDOW_MS = 60_000;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rewind-email-"));
  journal = new Journal(path.join(tmpDir, "journal.sqlite"));

  const created = createEmailMcpServer(path.join(tmpDir, "email.sqlite"), {
    deliveryWindowMs: WINDOW_MS,
  });
  store = created.store;
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "email-test", version: "0.0.1" });
  await Promise.all([created.server.connect(serverT), client.connect(clientT)]);

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
});

afterEach(async () => {
  await client.close().catch(() => {});
  journal.close();
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function entryFor(preStateRef: string | null, tool: string): ActionRecord {
  return {
    id: "test-action",
    ts: new Date().toISOString(),
    executedTs: new Date().toISOString(),
    sessionId: "t",
    connector: "email",
    tool,
    argsRedacted: {},
    class: "destructive",
    riskScore: 0.8,
    blastRadius: 1,
    preStateRef,
    status: "executed",
    resultSummary: null,
    causedBy: null,
  };
}

describe("mock email connector", () => {
  it("seeds 200 inbox messages exactly once", () => {
    expect(seedInbox(store)).toBe(200);
    expect(store.count("inbox")).toBe(200);
    expect(seedInbox(store)).toBe(0); // idempotent
    expect(store.count("inbox")).toBe(200);
  });

  it("delete_message → undo restores the message to its original folder", async () => {
    seedInbox(store, 5);
    const victim = store.list("inbox")[2]!;
    const { manifest } = createEmailConnector();
    const cap = manifest.tools.delete_message!.compensator!;

    const ref = await cap.capture({ id: victim.id }, ctx);
    store.moveTo(victim.id, "__trash");
    expect(store.get(victim.id)!.folder).toBe("__trash");

    const result = await cap.undo(entryFor(ref, "delete_message"), ctx);
    expect(result.outcome).toBe("undone");
    expect(store.get(victim.id)!.folder).toBe("inbox");
  });

  it("delete_many on a 200-message inbox → undo restores all 200", async () => {
    seedInbox(store, 200);
    const { manifest } = createEmailConnector();
    const cap = manifest.tools.delete_many!.compensator!;

    const ref = await cap.capture({ folder: "inbox" }, ctx);
    const trashed = store.trashFolder("inbox");
    expect(trashed).toHaveLength(200);
    expect(store.count("inbox")).toBe(0);
    expect(store.count("__trash")).toBe(200);

    const result = await cap.undo(entryFor(ref, "delete_many"), ctx);
    expect(result.outcome).toBe("undone");
    expect(result.detail).toContain("200");
    expect(store.count("inbox")).toBe(200);
    expect(store.count("__trash")).toBe(0);
  });

  it("send → recall within the delivery window cancels the send", async () => {
    const { manifest } = createEmailConnector();
    const cap = manifest.tools.send_message!.compensator!;
    const args = { to: "ceo@example.com", subject: "Resignation", body: "I quit!" };

    const ref = await cap.capture(args, ctx);
    store.send({ from: "agent@agent-rewind.local", deliveryWindowMs: WINDOW_MS, ...args });
    expect(store.count("outbox")).toBe(1);

    const result = await cap.undo(entryFor(ref, "send_message"), ctx);
    expect(result.outcome).toBe("undone");
    expect(store.count("outbox")).toBe(0);
    expect(store.count("sent")).toBe(0);
    expect(store.count("__recalled")).toBe(1);
  });

  it("send → after delivery the undo is honestly not-reversible", async () => {
    const { manifest } = createEmailConnector();
    const cap = manifest.tools.send_message!.compensator!;
    const args = { to: "all@example.com", subject: "Oops", body: "..." };

    const ref = await cap.capture(args, ctx);
    store.send({ from: "agent@agent-rewind.local", deliveryWindowMs: 0, ...args });
    expect(store.deliverDue(new Date(Date.now() + 1))).toBe(1);
    expect(store.count("sent")).toBe(1);

    const result = await cap.undo(entryFor(ref, "send_message"), ctx);
    expect(result.outcome).toBe("not-reversible");
    expect(result.detail).toMatch(/window elapsed|already delivered/i);
    expect(store.count("sent")).toBe(1); // nothing silently faked
  });

  it("move_message → undo moves it back", async () => {
    seedInbox(store, 3);
    const msg = store.list("inbox")[0]!;
    const { manifest } = createEmailConnector();
    const cap = manifest.tools.move_message!.compensator!;

    const ref = await cap.capture({ id: msg.id, folder: "sent" }, ctx);
    store.moveTo(msg.id, "sent");
    const result = await cap.undo(entryFor(ref, "move_message"), ctx);
    expect(result.outcome).toBe("undone");
    expect(store.get(msg.id)!.folder).toBe("inbox");
  });

  it("blast radius of delete_many equals the folder's message count", async () => {
    seedInbox(store, 200);
    const { manifest } = createEmailConnector();
    const radius = await manifest.tools.delete_many!.blastRadius!({ folder: "inbox" }, ctx);
    expect(radius).toBe(200);
    expect(radius).toBeGreaterThan(manifest.holdThreshold);
  });

  it("undo of delete_many is idempotent", async () => {
    seedInbox(store, 10);
    const { manifest } = createEmailConnector();
    const cap = manifest.tools.delete_many!.compensator!;
    const ref = await cap.capture({ folder: "inbox" }, ctx);
    store.trashFolder("inbox");
    await cap.undo(entryFor(ref, "delete_many"), ctx);
    const again = await cap.undo(entryFor(ref, "delete_many"), ctx);
    expect(again.outcome).toBe("undone");
    expect(store.count("inbox")).toBe(10);
  });
});
