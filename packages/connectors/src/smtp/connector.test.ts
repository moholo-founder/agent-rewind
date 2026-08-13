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
import { createSmtpConnector } from "./connector.js";
import type { OutboundMail } from "./mailer.js";
import { createSmtpMcpServer } from "./server.js";

let tmpDir: string;
let journal: Journal;
let client: Client;
let ctx: CompensatorContext;
let delivered: OutboundMail[];
let failNext: Error | null;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rewind-smtp-"));
  journal = new Journal(path.join(tmpDir, "journal.sqlite"));
  delivered = [];
  failNext = null;

  const server = createSmtpMcpServer({
    from: "founder@moholo.example",
    deliver: async (mail) => {
      if (failNext) throw failNext;
      delivered.push(mail);
      return { messageId: `<${delivered.length}@test>` };
    },
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "smtp-test", version: "0.0.1" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  ctx = {
    snapshots: new SnapshotStore(path.join(tmpDir, "snaps"), journal),
    callDownstream: async (tool, args) => {
      const result = await client.callTool({ name: tool, arguments: args });
      if (result.isError) throw new Error("downstream error");
      return result;
    },
  };
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
    connector: "smtp",
    tool: "send_email",
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

const ARGS = {
  to: "prospect@example.com",
  subject: "Agent Rewind — quick intro",
  body: "Hi — saw your post about agent safety...",
};

describe("smtp connector", () => {
  it("holds EVERY send by default (threshold 0)", () => {
    const { manifest } = createSmtpConnector();
    expect(manifest.holdThreshold).toBe(0);
    expect(manifest.tools.send_email!.class).toBe("destructive");
  });

  it("send_email delivers with the configured From address", async () => {
    const result = await client.callTool({ name: "send_email", arguments: ARGS });
    const payload = JSON.parse(
      (result.content as { text: string }[])[0]!.text,
    ) as { sent: boolean; messageId: string };
    expect(payload.sent).toBe(true);
    expect(payload.messageId).toBe("<1@test>");
    expect(delivered).toEqual([
      { from: "founder@moholo.example", text: ARGS.body, to: ARGS.to, subject: ARGS.subject },
    ]);
  });

  it("rejects a malformed recipient address before delivery", async () => {
    const result = await client.callTool({
      name: "send_email",
      arguments: { ...ARGS, to: "not-an-email" },
    });
    expect(result.isError).toBe(true);
    expect(delivered).toHaveLength(0);
  });

  it("SMTP failure surfaces as a tool error", async () => {
    failNext = new Error("530 Authentication required");
    const result = await client.callTool({ name: "send_email", arguments: ARGS });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("530");
  });

  it("capture archives the exact draft; undo is honestly not-reversible", async () => {
    const { manifest } = createSmtpConnector();
    const cap = manifest.tools.send_email!.compensator!;
    const ref = await cap.capture(ARGS, ctx);
    expect(ref).not.toBeNull();
    const draft = ctx.snapshots.getRecord<{ kind: string; body: string }>(ref!);
    expect(draft.kind).toBe("smtp-send");
    expect(draft.body).toBe(ARGS.body);

    const result = await cap.undo(entryFor(ref), ctx);
    expect(result.outcome).toBe("not-reversible");
    expect(result.detail).toContain(ARGS.subject);
    expect(result.detail).toMatch(/cannot be recalled/i);
  });
});
