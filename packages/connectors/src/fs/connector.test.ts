import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Journal,
  SnapshotStore,
  type ActionRecord,
  type CompensatorContext,
} from "@agentrewind/core";
import { createFilesystemConnector } from "./connector.js";
import * as ops from "./ops.js";
import { SandboxViolation } from "./sandbox.js";

let tmpDir: string;
let root: string;
let journal: Journal;
let ctx: CompensatorContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rewind-fs-"));
  root = path.join(tmpDir, "sandbox");
  journal = new Journal(path.join(tmpDir, "journal.sqlite"));
  ctx = {
    snapshots: new SnapshotStore(path.join(tmpDir, "snaps"), journal),
    callDownstream: async () => {
      throw new Error("filesystem compensators must not need downstream calls");
    },
  };
});

afterEach(() => {
  journal.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function entryFor(preStateRef: string | null, tool: string): ActionRecord {
  return {
    id: "test-action",
    ts: new Date().toISOString(),
    executedTs: new Date().toISOString(),
    sessionId: "t",
    connector: "filesystem",
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

describe("filesystem compensators (round trips)", () => {
  it("write_file over existing content → undo restores byte-identical original", async () => {
    const { manifest, sandbox } = createFilesystemConnector({ root });
    const original = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]); // binary on purpose
    fs.writeFileSync(path.join(root, "data.bin"), original);

    const cap = manifest.tools.write_file!.compensator!;
    const ref = await cap.capture({ path: "data.bin", content: "overwritten" }, ctx);
    ops.writeFile(sandbox, "data.bin", "overwritten");
    expect(fs.readFileSync(path.join(root, "data.bin"), "utf8")).toBe("overwritten");

    const result = await cap.undo(entryFor(ref, "write_file"), ctx);
    expect(result.outcome).toBe("undone");
    expect(fs.readFileSync(path.join(root, "data.bin")).equals(original)).toBe(true);
  });

  it("write_file creating a new file → undo removes it", async () => {
    const { manifest, sandbox } = createFilesystemConnector({ root });
    const cap = manifest.tools.write_file!.compensator!;
    const ref = await cap.capture({ path: "new/nested/file.txt", content: "hi" }, ctx);
    ops.writeFile(sandbox, "new/nested/file.txt", "hi");

    const result = await cap.undo(entryFor(ref, "write_file"), ctx);
    expect(result.outcome).toBe("undone");
    expect(fs.existsSync(path.join(root, "new/nested/file.txt"))).toBe(false);
  });

  it("delete_file → undo restores byte-identical content", async () => {
    const { manifest, sandbox } = createFilesystemConnector({ root });
    const original = Buffer.from("précieux contenu \u{1F512}", "utf8");
    fs.writeFileSync(path.join(root, "keep.txt"), original);

    const cap = manifest.tools.delete_file!.compensator!;
    const ref = await cap.capture({ path: "keep.txt" }, ctx);
    ops.deleteFile(sandbox, "keep.txt");
    expect(fs.existsSync(path.join(root, "keep.txt"))).toBe(false);

    const result = await cap.undo(entryFor(ref, "delete_file"), ctx);
    expect(result.outcome).toBe("undone");
    expect(fs.readFileSync(path.join(root, "keep.txt")).equals(original)).toBe(true);
  });

  it("delete_dir with 200 files → undo restores the whole tree byte-identical", async () => {
    const { manifest, sandbox } = createFilesystemConnector({ root });
    const dir = path.join(root, "inbox-archive");
    const originals = new Map<string, Buffer>();
    for (let i = 0; i < 200; i++) {
      const rel = `inbox-archive/${String(Math.floor(i / 20)).padStart(2, "0")}/msg-${i}.eml`;
      const content = Buffer.from(`Message #${i}\nBody bytes: ${"x".repeat(i)}\n`);
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
      originals.set(rel, content);
    }
    expect(ops.countFiles(sandbox, "inbox-archive")).toBe(200);

    const cap = manifest.tools.delete_dir!.compensator!;
    const ref = await cap.capture({ path: "inbox-archive" }, ctx);
    ops.deleteDir(sandbox, "inbox-archive");
    expect(fs.existsSync(dir)).toBe(false);

    const result = await cap.undo(entryFor(ref, "delete_dir"), ctx);
    expect(result.outcome).toBe("undone");
    for (const [rel, content] of originals) {
      expect(fs.readFileSync(path.join(root, rel)).equals(content)).toBe(true);
    }
    expect(ops.countFiles(sandbox, "inbox-archive")).toBe(200);
  });

  it("delete_dir undo is idempotent", async () => {
    const { manifest, sandbox } = createFilesystemConnector({ root });
    fs.mkdirSync(path.join(root, "d"));
    fs.writeFileSync(path.join(root, "d/a.txt"), "aaa");
    const cap = manifest.tools.delete_dir!.compensator!;
    const ref = await cap.capture({ path: "d" }, ctx);
    ops.deleteDir(sandbox, "d");
    await cap.undo(entryFor(ref, "delete_dir"), ctx);
    const again = await cap.undo(entryFor(ref, "delete_dir"), ctx);
    expect(again.outcome).toBe("undone");
    expect(fs.readFileSync(path.join(root, "d/a.txt"), "utf8")).toBe("aaa");
  });

  it("move → undo moves back and restores an overwritten destination", async () => {
    const { manifest, sandbox } = createFilesystemConnector({ root });
    fs.writeFileSync(path.join(root, "a.txt"), "AAA");
    fs.writeFileSync(path.join(root, "b.txt"), "BBB-original");

    const cap = manifest.tools.move!.compensator!;
    const ref = await cap.capture({ src: "a.txt", dest: "b.txt" }, ctx);
    ops.move(sandbox, "a.txt", "b.txt");
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("AAA");

    const result = await cap.undo(entryFor(ref, "move"), ctx);
    expect(result.outcome).toBe("undone");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("AAA");
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("BBB-original");
  });

  it("move undo reports honest failure when the moved file has vanished", async () => {
    const { manifest, sandbox } = createFilesystemConnector({ root });
    fs.writeFileSync(path.join(root, "a.txt"), "AAA");
    const cap = manifest.tools.move!.compensator!;
    const ref = await cap.capture({ src: "a.txt", dest: "moved.txt" }, ctx);
    ops.move(sandbox, "a.txt", "moved.txt");
    fs.rmSync(path.join(root, "moved.txt")); // world changed under us

    const result = await cap.undo(entryFor(ref, "move"), ctx);
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("moved.txt");
  });

  it("delete_dir undo reports partial when a snapshot blob is missing", async () => {
    const { manifest, sandbox } = createFilesystemConnector({ root });
    fs.mkdirSync(path.join(root, "p"));
    fs.writeFileSync(path.join(root, "p/one.txt"), "one");
    fs.writeFileSync(path.join(root, "p/two.txt"), "two");
    const cap = manifest.tools.delete_dir!.compensator!;
    const ref = await cap.capture({ path: "p" }, ctx);
    ops.deleteDir(sandbox, "p");

    // Sabotage: remove one content blob from the store.
    const tree = ctx.snapshots.getRecord<{ entries: { type: string; contentRef?: string }[] }>(ref!);
    const fileEntry = tree.entries.find((e) => e.type === "file" && e.contentRef);
    const blobPath = path.join(tmpDir, "snaps", fileEntry!.contentRef!.slice(0, 2), fileEntry!.contentRef!);
    fs.rmSync(blobPath);

    const result = await cap.undo(entryFor(ref, "delete_dir"), ctx);
    expect(result.outcome).toBe("partial");
    expect(result.detail).toMatch(/Restored 1\/2 files/);
  });
});

describe("sandbox guard", () => {
  it("refuses .. traversal and absolute paths", () => {
    const { sandbox } = createFilesystemConnector({ root });
    expect(() => sandbox.resolve("../outside.txt")).toThrow(SandboxViolation);
    expect(() => sandbox.resolve("a/../../outside.txt")).toThrow(SandboxViolation);
    expect(() => sandbox.resolve("/etc/passwd")).toThrow(SandboxViolation);
  });

  it("refuses symlink escapes", (ctx) => {
    const { sandbox } = createFilesystemConnector({ root });
    const outside = path.join(tmpDir, "outside-secret");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "leak me");
    try {
      fs.symlinkSync(outside, path.join(root, "sneaky"));
    } catch {
      // Windows without symlink privilege can't create the attack vector at
      // all — nothing to guard against; skip rather than fake a pass.
      ctx.skip();
      return;
    }

    expect(() => sandbox.resolve("sneaky/secret.txt")).toThrow(SandboxViolation);
    expect(() => ops.readFile(sandbox, "sneaky/secret.txt")).toThrow(SandboxViolation);
    expect(() => ops.deleteDir(sandbox, "sneaky")).toThrow(SandboxViolation);
  });

  it("allows normal nested paths inside the sandbox", () => {
    const { sandbox } = createFilesystemConnector({ root });
    expect(sandbox.resolve("a/b/c.txt")).toBe(path.join(sandbox.root, "a/b/c.txt"));
  });
});

describe("blast radius", () => {
  it("counts files recursively for delete_dir", async () => {
    const { manifest } = createFilesystemConnector({ root });
    fs.mkdirSync(path.join(root, "big/sub"), { recursive: true });
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(root, "big", i % 2 ? "sub" : ".", `f${i}.txt`), "x");
    }
    const radius = await manifest.tools.delete_dir!.blastRadius!({ path: "big" }, ctx);
    expect(radius).toBe(30);
    expect(radius).toBeGreaterThan(manifest.holdThreshold);
  });
});

describe("review regressions — sandbox & compensators", () => {
  it("refuses a DANGLING symlink (existsSync would skip it)", (ctx) => {
    const { sandbox } = createFilesystemConnector({ root });
    try {
      fs.symlinkSync(path.join(tmpDir, "does-not-exist-yet"), path.join(root, "dangler"));
    } catch {
      ctx.skip(); // no symlink privilege on this OS
      return;
    }
    expect(() => sandbox.resolve("dangler")).toThrow(SandboxViolation);
    expect(() => sandbox.resolve("dangler/child.txt")).toThrow(SandboxViolation);
    // The escape the dangling link enabled: writing through it would land
    // outside the sandbox once the target springs into existence.
    expect(() => ops.writeFile(sandbox, "dangler", "payload")).toThrow(SandboxViolation);
  });

  it("delete_file of a symlink → undo restores the LINK, not a copied file", async (ctx) => {
    const { manifest, sandbox } = createFilesystemConnector({ root });
    fs.writeFileSync(path.join(root, "target.txt"), "target content");
    try {
      fs.symlinkSync("target.txt", path.join(root, "alias"));
    } catch {
      ctx.skip();
      return;
    }
    const cap = manifest.tools.delete_file!.compensator!;
    const ref = await cap.capture({ path: "alias" }, ctx2());
    ops.deleteFile(sandbox, "alias");
    expect(fs.existsSync(path.join(root, "alias"))).toBe(false);

    const result = await cap.undo(entryFor(ref, "delete_file"), ctx2());
    expect(result.outcome).toBe("undone");
    expect(fs.lstatSync(path.join(root, "alias")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(root, "alias"))).toBe("target.txt");
  });
});

function ctx2() {
  return ctx;
}
