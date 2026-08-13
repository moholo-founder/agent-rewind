import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal } from "@agentrewind/core";
import { AgentRewindRuntime } from "@agentrewind/proxy";
import { runHook, type HookInput } from "./hooks.js";

let home: string;
let work: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ar-hooks-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "ar-hooks-work-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

function openJournal(): Journal {
  return new Journal(path.join(home, "journal.sqlite"));
}

function pre(tool: string, tool_input: Record<string, unknown>, extra: Partial<HookInput> = {}) {
  return runHook(
    { hook_event_name: "PreToolUse", session_id: "s", tool_name: tool, tool_input, ...extra },
    { home },
  );
}

function post(tool: string, tool_input: Record<string, unknown>, extra: Partial<HookInput> = {}) {
  return runHook(
    { hook_event_name: "PostToolUse", session_id: "s", tool_name: tool, tool_input, ...extra },
    { home },
  );
}

describe("Claude Code hooks capture", () => {
  it("ignores untracked tools", () => {
    const result = pre("Read", { file_path: "/x" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBeUndefined();
    const j = openJournal();
    expect(j.list()).toHaveLength(0);
    j.close();
  });

  it("Write: snapshots pre-state, journals pending, then executed on post", () => {
    const file = path.join(work, "config.json");
    fs.writeFileSync(file, "original-content");

    const preResult = pre("Write", { file_path: file, content: "clobbered" }, { tool_use_id: "t1" });
    expect(preResult.exitCode).toBe(0); // allowed — recorder, not blocker

    let j = openJournal();
    let row = j.list()[0]!;
    expect(row.connector).toBe("claude-code");
    expect(row.tool).toBe("Write");
    expect(row.status).toBe("pending"); // intent recorded before the edit
    expect(row.preStateRef).not.toBeNull();
    j.close();

    // (Claude Code performs the write here)
    fs.writeFileSync(file, "clobbered");
    const postResult = post("Write", { file_path: file, content: "clobbered" }, { tool_use_id: "t1" });
    expect(postResult.exitCode).toBe(0);

    j = openJournal();
    row = j.get(row.id);
    expect(row.status).toBe("executed");
    expect(row.executedTs).not.toBeNull();
    j.close();
  });

  it("undo of a hook-captured Write restores the file via the runtime", async () => {
    const file = path.join(work, "notes.md");
    fs.writeFileSync(file, "the truth");
    pre("Write", { file_path: file, content: "lies" }, { tool_use_id: "t2" });
    fs.writeFileSync(file, "lies");
    post("Write", { file_path: file, content: "lies" }, { tool_use_id: "t2" });

    const runtime = new AgentRewindRuntime({
      dbPath: path.join(home, "journal.sqlite"),
      snapshotDir: path.join(home, "snapshots"),
    });
    const action = runtime.journal.list()[0]!;
    const result = await runtime.undoAction(action.id);
    expect(result.outcome).toBe("undone");
    expect(fs.readFileSync(file, "utf8")).toBe("the truth");
    expect(runtime.journal.get(action.id).status).toBe("undone");
    await runtime.close();
  });

  it("undo of a Write that CREATED a file removes it", async () => {
    const file = path.join(work, "brand-new.txt");
    pre("Write", { file_path: file, content: "x" }, { tool_use_id: "t3" });
    fs.writeFileSync(file, "x");
    post("Write", { file_path: file, content: "x" }, { tool_use_id: "t3" });

    const runtime = new AgentRewindRuntime({
      dbPath: path.join(home, "journal.sqlite"),
      snapshotDir: path.join(home, "snapshots"),
    });
    const result = await runtime.undoAction(runtime.journal.list()[0]!.id);
    expect(result.outcome).toBe("undone");
    expect(fs.existsSync(file)).toBe(false);
    await runtime.close();
  });

  it("STOP denies every tracked native tool and journals the block", () => {
    const j = openJournal();
    j.setStopped(true);
    j.close();

    for (const [tool, input] of [
      ["Bash", { command: "echo hi" }],
      ["Write", { file_path: path.join(work, "f"), content: "x" }],
      ["Edit", { file_path: path.join(work, "f"), old_string: "a", new_string: "b" }],
    ] as const) {
      const result = pre(tool, input as Record<string, unknown>);
      expect(result.stdout).toBeDefined();
      const out = JSON.parse(result.stdout!) as {
        decision: string;
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(out.decision).toBe("block");
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    }
    const j2 = openJournal();
    expect(j2.list().every((a) => a.status === "blocked-by-stop")).toBe(true);
    expect(j2.list()).toHaveLength(3);
    j2.close();
  });

  it("dangerous Bash escalates to a permission prompt; safe Bash passes", () => {
    const danger = pre("Bash", { command: "rm -rf / --no-preserve-root" });
    expect(danger.stdout).toBeDefined();
    const out = JSON.parse(danger.stdout!) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");

    const safe = pre("Bash", { command: "ls -la" });
    expect(safe.stdout).toBeUndefined(); // plain allow

    const j = openJournal();
    const rows = j.list();
    expect(rows.find((r) => r.class === "destructive")).toBeDefined(); // rm -rf
    expect(rows).toHaveLength(2); // both journaled either way
    j.close();
  });

  it("Bash is journaled but honestly not-reversible on undo", async () => {
    pre("Bash", { command: "echo done" }, { tool_use_id: "t4" });
    post("Bash", { command: "echo done" }, { tool_use_id: "t4" });

    const runtime = new AgentRewindRuntime({
      dbPath: path.join(home, "journal.sqlite"),
      snapshotDir: path.join(home, "snapshots"),
    });
    const result = await runtime.undoAction(runtime.journal.list()[0]!.id);
    expect(result.outcome).toBe("not-reversible");
    expect(result.detail).toMatch(/no automatic inverse/i);
    await runtime.close();
  });

  it("post without a pre row still records the completion (nothing unrecorded)", () => {
    post("Edit", { file_path: path.join(work, "orphan.ts") }, { tool_use_id: "t5" });
    const j = openJournal();
    const row = j.list()[0]!;
    expect(row.status).toBe("executed");
    expect(row.tool).toBe("Edit");
    j.close();
  });

  it("sweeps abandoned pending rows to failed after the TTL", () => {
    pre("Bash", { command: "sleep 999" }, { tool_use_id: "t6" });
    const pendingFile = path.join(home, "hook-pending", "t6");
    expect(fs.existsSync(pendingFile)).toBe(true);
    // Age the pending marker past the TTL, then any later hook invocation sweeps.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(pendingFile, old, old);

    pre("Bash", { command: "ls" }, { tool_use_id: "t7" });

    const j = openJournal();
    const swept = j.list().find((a) => a.status === "failed");
    expect(swept?.status).toBe("failed");
    expect(swept?.resultSummary).toMatch(/No completion observed/);
    expect(fs.existsSync(pendingFile)).toBe(false);
    j.close();
  });
});

describe("Bash file-effect snapshots", () => {
  function bashRoundTrip(cwd: string, id: string, mutate: () => void) {
    pre("Bash", { command: "make chaos" }, { tool_use_id: id, cwd });
    mutate();
    post("Bash", { command: "make chaos" }, { tool_use_id: id, cwd });
  }

  it("undoes a Bash command's file effects: modified, created, deleted", async () => {
    fs.writeFileSync(path.join(work, "config.yaml"), "replicas: 3");
    fs.writeFileSync(path.join(work, "keep.txt"), "keep me");
    fs.mkdirSync(path.join(work, "src"));
    fs.writeFileSync(path.join(work, "src/app.ts"), "export const x = 1;");

    bashRoundTrip(work, "b1", () => {
      fs.writeFileSync(path.join(work, "config.yaml"), "replicas: 0");   // modified
      fs.writeFileSync(path.join(work, "pwned.txt"), "created by cmd");  // created
      fs.rmSync(path.join(work, "src/app.ts"));                          // deleted
    });

    const runtime = new AgentRewindRuntime({
      dbPath: path.join(home, "journal.sqlite"),
      snapshotDir: path.join(home, "snapshots"),
    });
    const action = runtime.journal.list()[0]!;
    expect(action.resultSummary).toContain("touched 3 files");

    const result = await runtime.undoAction(action.id);
    expect(result.outcome).toBe("undone");
    expect(fs.readFileSync(path.join(work, "config.yaml"), "utf8")).toBe("replicas: 3");
    expect(fs.readFileSync(path.join(work, "src/app.ts"), "utf8")).toBe("export const x = 1;");
    expect(fs.existsSync(path.join(work, "pwned.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(work, "keep.txt"), "utf8")).toBe("keep me"); // untouched
    await runtime.close();
  });

  it("a no-op command reports no file effects and undo is a clean no-op", async () => {
    fs.writeFileSync(path.join(work, "a.txt"), "a");
    bashRoundTrip(work, "b2", () => {});
    const runtime = new AgentRewindRuntime({
      dbPath: path.join(home, "journal.sqlite"),
      snapshotDir: path.join(home, "snapshots"),
    });
    const action = runtime.journal.list()[0]!;
    expect(action.resultSummary).toContain("no file changes");
    const result = await runtime.undoAction(action.id);
    expect(result.outcome).toBe("undone");
    expect(fs.readFileSync(path.join(work, "a.txt"), "utf8")).toBe("a");
    await runtime.close();
  });

  it("crash before completion: manifest alone refuses to restore blindly", async () => {
    fs.writeFileSync(path.join(work, "f.txt"), "v1");
    pre("Bash", { command: "explode" }, { tool_use_id: "b3", cwd: work });
    // no post — command never completed
    const runtime = new AgentRewindRuntime({
      dbPath: path.join(home, "journal.sqlite"),
      snapshotDir: path.join(home, "snapshots"),
    });
    const pending = runtime.journal.list()[0]!;
    runtime.journal.transition(pending.id, "executed", { executedTs: new Date().toISOString() });
    const result = await runtime.undoAction(pending.id);
    expect(result.outcome).toBe("not-reversible");
    expect(result.detail).toMatch(/never observed/);
    await runtime.close();
  });

  it("excluded dirs (node_modules) are not captured", () => {
    fs.mkdirSync(path.join(work, "node_modules/pkg"), { recursive: true });
    fs.writeFileSync(path.join(work, "node_modules/pkg/index.js"), "x".repeat(1000));
    fs.writeFileSync(path.join(work, "real.txt"), "real");
    pre("Bash", { command: "ls" }, { tool_use_id: "b4", cwd: work });
    const j = openJournal();
    const row = j.list()[0]!;
    expect(row.preStateRef).not.toBeNull();
    j.close();
    const runtime = new AgentRewindRuntime({
      dbPath: path.join(home, "journal.sqlite"),
      snapshotDir: path.join(home, "snapshots"),
    });
    const manifest = runtime.snapshots.getRecord<{ files: Record<string, string> }>(row.preStateRef!);
    expect(Object.keys(manifest.files)).toEqual(["real.txt"]);
    return runtime.close();
  });
});
