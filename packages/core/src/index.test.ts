import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal } from "./journal.js";
import { defaultRiskScore, gate } from "./policy.js";
import { redactArgs } from "./redact.js";
import { executeRewind } from "./rewind.js";
import { SnapshotStore } from "./snapshots.js";
import type { CapabilityManifest, NewAction } from "./index.js";

let tmpDir: string;
let journal: Journal;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rewind-core-"));
  journal = new Journal(path.join(tmpDir, "journal.sqlite"));
});

afterEach(() => {
  journal.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sampleAction(overrides: Partial<NewAction> = {}): NewAction {
  return {
    sessionId: "s1",
    connector: "filesystem",
    tool: "delete_file",
    argsRedacted: { path: "/sandbox/a.txt" },
    class: "destructive",
    riskScore: 0.8,
    blastRadius: 1,
    status: "pending",
    ...overrides,
  };
}

describe("Journal", () => {
  it("writes and reads back an action entry", () => {
    const rec = journal.record(sampleAction());
    const fetched = journal.get(rec.id);
    expect(fetched.tool).toBe("delete_file");
    expect(fetched.argsRedacted).toEqual({ path: "/sandbox/a.txt" });
    expect(fetched.status).toBe("pending");
    expect(fetched.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("persists across reopen (durable)", () => {
    const dbPath = path.join(tmpDir, "durable.sqlite");
    const j1 = new Journal(dbPath);
    const rec = j1.record(sampleAction());
    j1.setStopped(true);
    j1.close();

    const j2 = new Journal(dbPath);
    expect(j2.get(rec.id).tool).toBe("delete_file");
    expect(j2.isStopped()).toBe(true);
    j2.close();
  });

  it("enforces append-only: identity columns cannot be rewritten", () => {
    const rec = journal.record(sampleAction());
    // Reach under the hood exactly like an attacker/bug would.
    const db = (journal as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    expect(() =>
      db.prepare("UPDATE actions SET tool = 'innocent_read' WHERE id = ?").run(rec.id),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare("UPDATE actions SET args_redacted = '{}' WHERE id = ?").run(rec.id),
    ).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM actions WHERE id = ?").run(rec.id)).toThrow(
      /append-only/,
    );
    expect(journal.get(rec.id).tool).toBe("delete_file");
  });

  it("whitelists status transitions and rejects illegal ones", () => {
    const rec = journal.record(sampleAction());
    journal.transition(rec.id, "executed", {
      executedTs: new Date().toISOString(),
    });
    expect(journal.get(rec.id).status).toBe("executed");
    expect(() => journal.transition(rec.id, "held")).toThrow(/Illegal status transition/);
    journal.transition(rec.id, "undone");
    expect(() => journal.transition(rec.id, "executed")).toThrow(
      /Illegal status transition/,
    );
  });

  it("orders rewindable actions LIFO by execution time, excluding reads and compensations", () => {
    const anchor = new Date(Date.now() - 60_000).toISOString();
    const a = journal.record(sampleAction({ tool: "first" }));
    const b = journal.record(sampleAction({ tool: "second" }));
    const read = journal.record(sampleAction({ tool: "read_file", class: "read" }));
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    journal.transition(a.id, "executed", { executedTs: at(5000) });
    journal.transition(b.id, "executed", { executedTs: at(2000) });
    journal.transition(read.id, "executed", { executedTs: at(4000) });
    const comp = journal.record(
      sampleAction({ tool: "undo:x", causedBy: a.id, executedTs: at(1000), status: "executed" }),
    );
    expect(comp.causedBy).toBe(a.id);

    const plan = journal.listRewindable(anchor);
    expect(plan.map((p) => p.tool)).toEqual(["second", "first"]);
  });

  it("stores and lists rewind session reports", () => {
    journal.recordRewind({
      rewindId: "rw1",
      anchor: "2026-08-12T00:00:00.000Z",
      startedTs: "2026-08-12T00:01:00.000Z",
      finishedTs: "2026-08-12T00:01:01.000Z",
      outcomes: [],
      fullyRestored: false,
    });
    expect(journal.listRewinds()[0]?.rewindId).toBe("rw1");
  });
});

describe("SnapshotStore", () => {
  it("stores and retrieves a blob by content hash", () => {
    const store = new SnapshotStore(path.join(tmpDir, "snaps"), journal);
    const content = Buffer.from("hello agent-rewind");
    const ref = store.putBlob(content, { origin: "test" });
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(store.getBlob(ref).equals(content)).toBe(true);
    expect(journal.getSnapshotEntry(ref)?.bytes).toBe(content.byteLength);
    // Same content → same ref (dedup).
    expect(store.putBlob(content)).toBe(ref);
  });

  it("round-trips JSON records", () => {
    const store = new SnapshotStore(path.join(tmpDir, "snaps"), journal);
    const value = { folder: "inbox", ids: [1, 2, 3] };
    const ref = store.putRecord(value);
    expect(store.getRecord(ref)).toEqual(value);
  });

  it("fails loudly on a corrupted snapshot instead of restoring garbage", () => {
    const store = new SnapshotStore(path.join(tmpDir, "snaps"), journal);
    const ref = store.putBlob(Buffer.from("important data"));
    const blobPath = path.join(tmpDir, "snaps", ref.slice(0, 2), ref);
    fs.writeFileSync(blobPath, "tampered");
    expect(() => store.getBlob(ref)).toThrow(/integrity/);
  });
});

describe("policy gate", () => {
  const manifest: CapabilityManifest = {
    connector: "filesystem",
    holdThreshold: 25,
    tools: {
      read_file: { class: "read" },
      delete_dir: { class: "destructive" },
    },
  };

  it("always passes reads, even under STOP", () => {
    expect(
      gate({ manifest, tool: "read_file", toolClass: "read", blastRadius: 1, stopped: true }),
    ).toEqual({ verdict: "pass-read" });
  });

  it("STOP blocks every side-effecting call", () => {
    expect(
      gate({ manifest, tool: "delete_dir", toolClass: "destructive", blastRadius: 1, stopped: true }),
    ).toEqual({ verdict: "block-stop" });
  });

  it("holds undeclared/unknown tools instead of executing", () => {
    const d = gate({
      manifest,
      tool: "format_disk",
      toolClass: "unknown",
      blastRadius: 1,
      stopped: false,
    });
    expect(d.verdict).toBe("hold");
  });

  it("holds blast-radius breaches and executes within threshold", () => {
    expect(
      gate({ manifest, tool: "delete_dir", toolClass: "destructive", blastRadius: 200, stopped: false })
        .verdict,
    ).toBe("hold");
    expect(
      gate({ manifest, tool: "delete_dir", toolClass: "destructive", blastRadius: 5, stopped: false })
        .verdict,
    ).toBe("execute");
  });

  it("derives default risk from class", () => {
    expect(defaultRiskScore("read")).toBe(0);
    expect(defaultRiskScore("destructive")).toBeGreaterThan(defaultRiskScore("reversible"));
  });
});

describe("redaction", () => {
  it("redacts denylisted keys to shape+hash, never the value", () => {
    const out = redactArgs({
      path: "/sandbox/x",
      apiKey: "sk-super-secret-value",
      nested: { authorization: "Bearer abc123", count: 3 },
    }) as Record<string, unknown>;
    expect(out.path).toBe("/sandbox/x");
    expect(JSON.stringify(out)).not.toContain("sk-super-secret-value");
    expect(JSON.stringify(out)).not.toContain("abc123");
    expect((out.apiKey as { __redacted: boolean }).__redacted).toBe(true);
    // Keyed HMAC + bucketed length: nothing dictionary-recoverable, but the
    // same secret still correlates within a runtime's lifetime.
    expect((out.apiKey as { hmac: string }).hmac).toMatch(/^[0-9a-f]{16}$/);
    expect((out.apiKey as { length: string }).length).toBe("16-31");
    const again = redactArgs({ apiKey: "sk-super-secret-value" }) as Record<string, unknown>;
    expect((again.apiKey as { hmac: string }).hmac).toBe((out.apiKey as { hmac: string }).hmac);
    expect(((out.nested as Record<string, unknown>).count)).toBe(3);
  });

  it("honors per-tool extra redact fields", () => {
    const out = redactArgs({ body: "confidential text" }, ["body"]) as Record<string, unknown>;
    expect((out.body as { __redacted: boolean }).__redacted).toBe(true);
  });
});

describe("rewind engine", () => {
  it("undoes LIFO, reports honestly on failure, and journals compensations", async () => {
    const anchor = new Date(Date.now() - 60_000).toISOString();
    const ok = journal.record(sampleAction({ tool: "delete_file" }));
    const bad = journal.record(sampleAction({ tool: "delete_dir" }));
    journal.transition(ok.id, "executed", { executedTs: new Date(Date.now() - 2000).toISOString() });
    journal.transition(bad.id, "executed", { executedTs: new Date(Date.now() - 1000).toISOString() });

    const order: string[] = [];
    const report = await executeRewind({
      journal,
      anchorIso: anchor,
      runUndo: async (action) => {
        order.push(action.tool);
        if (action.tool === "delete_dir") {
          throw new Error("disk went away");
        }
        return { outcome: "undone", detail: "restored 1 file" };
      },
    });

    // LIFO: delete_dir executed last, so it is undone first.
    expect(order).toEqual(["delete_dir", "delete_file"]);
    expect(report.fullyRestored).toBe(false);
    expect(report.outcomes.find((o) => o.actionId === bad.id)?.outcome).toBe("failed");
    expect(report.outcomes.find((o) => o.actionId === ok.id)?.outcome).toBe("undone");
    expect(journal.get(bad.id).status).toBe("undo-failed");
    expect(journal.get(ok.id).status).toBe("undone");

    // Compensating entries were appended and linked, originals not deleted.
    const all = journal.list();
    const comps = all.filter((a) => a.causedBy !== null);
    expect(comps).toHaveLength(2);
    expect(journal.listRewinds()).toHaveLength(1);
  });

  it("is idempotent: a second rewind over the same span has nothing to do", async () => {
    const anchor = new Date(Date.now() - 60_000).toISOString();
    const a = journal.record(sampleAction());
    journal.transition(a.id, "executed", { executedTs: new Date().toISOString() });
    await executeRewind({
      journal,
      anchorIso: anchor,
      runUndo: async () => ({ outcome: "undone", detail: "ok" }),
    });
    const second = await executeRewind({
      journal,
      anchorIso: anchor,
      runUndo: async () => ({ outcome: "undone", detail: "ok" }),
    });
    expect(second.outcomes).toHaveLength(0);
    expect(second.fullyRestored).toBe(false);
  });
});

describe("review regressions — core", () => {
  it("refuses NULL-id identity destruction (IS NOT trigger semantics)", () => {
    const rec = journal.record(sampleAction());
    const db = (journal as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    expect(() =>
      db.prepare("UPDATE actions SET id = NULL WHERE id = ?").run(rec.id),
    ).toThrow(/append-only/);
    expect(journal.get(rec.id).id).toBe(rec.id);
  });

  it("rewind_sessions refuses UPDATE as well as DELETE", () => {
    journal.recordRewind({
      rewindId: "rw-upd",
      anchor: "2026-08-12T00:00:00.000Z",
      startedTs: "2026-08-12T00:01:00.000Z",
      finishedTs: "2026-08-12T00:01:01.000Z",
      outcomes: [],
      fullyRestored: true,
    });
    const db = (journal as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    expect(() =>
      db.prepare("UPDATE rewind_sessions SET report = '{}' WHERE id = 'rw-upd'").run(),
    ).toThrow(/append-only/);
  });

  it("gate fails closed on a non-finite blast radius", () => {
    const manifest: CapabilityManifest = {
      connector: "filesystem",
      holdThreshold: 25,
      tools: { delete_dir: { class: "destructive" } },
    };
    for (const radius of [NaN, Infinity, -1]) {
      expect(
        gate({ manifest, tool: "delete_dir", toolClass: "destructive", blastRadius: radius, stopped: false })
          .verdict,
      ).toBe("hold");
    }
  });

  it("rewind honors onlyActionIds and reports already-undone rows honestly", async () => {
    const anchor = new Date(Date.now() - 60_000).toISOString();
    const a = journal.record(sampleAction({ tool: "one" }));
    const b = journal.record(sampleAction({ tool: "two" }));
    const c = journal.record(sampleAction({ tool: "three" }));
    for (const [i, rec] of [a, b, c].entries()) {
      journal.transition(rec.id, "executed", {
        executedTs: new Date(Date.now() - 3000 + i * 1000).toISOString(),
      });
    }
    const ran: string[] = [];
    const report = await executeRewind({
      journal,
      anchorIso: anchor,
      onlyActionIds: [a.id, c.id], // operator previewed only these
      runUndo: async (action) => {
        ran.push(action.tool);
        if (action.id === c.id) {
          // Simulate a concurrent single-undo of `a` landing mid-rewind:
          // the engine must re-fetch and skip it, not re-run its undo.
          journal.transition(a.id, "undone");
        }
        return { outcome: "undone", detail: "ok" };
      },
    });

    expect(ran).toEqual(["three"]); // LIFO: c first; a skipped; b excluded
    expect(report.outcomes).toHaveLength(2);
    expect(report.outcomes.find((o) => o.actionId === a.id)?.detail).toMatch(/Already undone/);
    expect(report.fullyRestored).toBe(true); // both truthfully undone
    expect(journal.get(b.id).status).toBe("executed"); // untouched
  });
});
