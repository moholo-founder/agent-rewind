import fs from "node:fs";
import path from "node:path";
import type {
  ActionRecord,
  CapabilityManifest,
  Compensator,
  CompensatorContext,
  UndoResult,
} from "@agentrewind/core";
import { countFiles } from "./ops.js";
import { Sandbox } from "./sandbox.js";

/**
 * Filesystem connector: capability manifest + compensators.
 *
 * Compensators run inside the Agent Rewind runtime (same machine as the
 * downstream filesystem server) and use direct fs access through the same
 * Sandbox guard, so an undo can never escape the sandbox either.
 */

interface FilePreState {
  kind: "file";
  rel: string;
  present: boolean;
  contentRef?: string;
  /** Set when the pre-state was a symlink: undo recreates the link itself. */
  symlinkTarget?: string;
}

interface MovePreState {
  kind: "move";
  src: string;
  dest: string;
  destExisted: boolean;
  destContentRef?: string;
}

interface TreeEntry {
  rel: string; // relative to the captured root
  type: "file" | "dir" | "symlink";
  contentRef?: string;
  target?: string;
}

interface TreePreState {
  kind: "tree";
  rootRel: string;
  fileCount: number;
  entries: TreeEntry[];
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`Missing string arg "${key}"`);
  return v;
}

/** True if the path exists as a directory entry, even as a dangling symlink. */
function isLstatable(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function captureTree(
  sandbox: Sandbox,
  rootRel: string,
  ctx: CompensatorContext,
): TreePreState {
  const rootAbs = sandbox.resolve(rootRel);
  const entries: TreeEntry[] = [];
  let fileCount = 0;
  const walk = (abs: string, rel: string): void => {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      entries.push({ rel, type: "symlink", target: fs.readlinkSync(abs) });
    } else if (st.isDirectory()) {
      entries.push({ rel, type: "dir" });
      for (const name of fs.readdirSync(abs)) {
        walk(path.join(abs, name), rel === "" ? name : `${rel}/${name}`);
      }
    } else {
      fileCount += 1;
      entries.push({
        rel,
        type: "file",
        contentRef: ctx.snapshots.putBlob(fs.readFileSync(abs)),
      });
    }
  };
  walk(rootAbs, "");
  return { kind: "tree", rootRel, fileCount, entries };
}

function restoreTree(
  sandbox: Sandbox,
  pre: TreePreState,
  ctx: CompensatorContext,
): UndoResult {
  let restored = 0;
  const failures: string[] = [];
  for (const entry of pre.entries) {
    const rel = entry.rel === "" ? pre.rootRel : `${pre.rootRel}/${entry.rel}`;
    try {
      const abs = sandbox.resolve(rel);
      if (entry.type === "dir") {
        fs.mkdirSync(abs, { recursive: true });
      } else if (entry.type === "symlink") {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true });
        fs.symlinkSync(entry.target ?? "", abs);
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, ctx.snapshots.getBlob(entry.contentRef ?? ""));
        restored += 1;
      }
    } catch (err) {
      failures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length === 0) {
    return {
      outcome: "undone",
      detail: `Restored ${pre.rootRel} (${restored} files)`,
    };
  }
  // Honest partial: some of the tree is back, some is not. Say exactly what.
  return {
    outcome: restored > 0 ? "partial" : "failed",
    detail: `Restored ${restored}/${pre.fileCount} files; failures: ${failures.slice(0, 5).join("; ")}${failures.length > 5 ? ` (+${failures.length - 5} more)` : ""}`,
  };
}

function restoreFile(
  sandbox: Sandbox,
  pre: FilePreState,
  ctx: CompensatorContext,
): UndoResult {
  const abs = sandbox.resolve(pre.rel);
  if (pre.present && pre.symlinkTarget !== undefined) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (fs.existsSync(abs) || isLstatable(abs)) fs.rmSync(abs);
    fs.symlinkSync(pre.symlinkTarget, abs);
    return { outcome: "undone", detail: `Restored symlink ${pre.rel}` };
  }
  if (pre.present) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, ctx.snapshots.getBlob(pre.contentRef ?? ""));
    return { outcome: "undone", detail: `Restored prior content of ${pre.rel}` };
  }
  // File did not exist before the action: undo means removing it.
  if (fs.existsSync(abs)) fs.rmSync(abs);
  return { outcome: "undone", detail: `Removed ${pre.rel} (did not exist before)` };
}

function getPreState<T>(entry: ActionRecord, ctx: CompensatorContext): T {
  if (!entry.preStateRef) {
    throw new Error(`Action ${entry.id} has no captured pre-state`);
  }
  return ctx.snapshots.getRecord<T>(entry.preStateRef);
}

export interface FilesystemConnector {
  manifest: CapabilityManifest;
  sandbox: Sandbox;
}

export function createFilesystemConnector(options: {
  root: string;
  holdThreshold?: number;
}): FilesystemConnector {
  const sandbox = new Sandbox(options.root);

  const writeFileCompensator: Compensator = {
    async capture(args, ctx) {
      const rel = str(args, "path");
      const abs = sandbox.resolve(rel);
      const pre: FilePreState = fs.existsSync(abs)
        ? { kind: "file", rel, present: true, contentRef: ctx.snapshots.putBlob(fs.readFileSync(abs)) }
        : { kind: "file", rel, present: false };
      return ctx.snapshots.putRecord(pre, { connector: "filesystem", tool: "write_file" });
    },
    async undo(entry, ctx) {
      return restoreFile(sandbox, getPreState<FilePreState>(entry, ctx), ctx);
    },
  };

  const moveCompensator: Compensator = {
    async capture(args, ctx) {
      const src = str(args, "src");
      const dest = str(args, "dest");
      const destAbs = sandbox.resolve(dest);
      const destExisted = fs.existsSync(destAbs);
      const pre: MovePreState = {
        kind: "move",
        src,
        dest,
        destExisted,
        ...(destExisted && fs.lstatSync(destAbs).isFile()
          ? { destContentRef: ctx.snapshots.putBlob(fs.readFileSync(destAbs)) }
          : {}),
      };
      return ctx.snapshots.putRecord(pre, { connector: "filesystem", tool: "move" });
    },
    async undo(entry, ctx) {
      const pre = getPreState<MovePreState>(entry, ctx);
      const srcAbs = sandbox.resolve(pre.src);
      const destAbs = sandbox.resolve(pre.dest);
      if (!fs.existsSync(destAbs)) {
        if (fs.existsSync(srcAbs)) {
          // Already back (idempotent undo) — desired state holds.
          return { outcome: "undone", detail: `${pre.src} already restored` };
        }
        return {
          outcome: "failed",
          detail: `Nothing at ${pre.dest} to move back — the file has since been moved or deleted`,
        };
      }
      fs.mkdirSync(path.dirname(srcAbs), { recursive: true });
      fs.renameSync(destAbs, srcAbs);
      if (pre.destExisted && pre.destContentRef) {
        fs.writeFileSync(destAbs, ctx.snapshots.getBlob(pre.destContentRef));
        return {
          outcome: "undone",
          detail: `Moved ${pre.dest} back to ${pre.src} and restored the file it had overwritten`,
        };
      }
      return { outcome: "undone", detail: `Moved ${pre.dest} back to ${pre.src}` };
    },
  };

  const deleteFileCompensator: Compensator = {
    async capture(args, ctx) {
      const rel = str(args, "path");
      const abs = sandbox.resolve(rel);
      const pre: FilePreState = fs.lstatSync(abs).isSymbolicLink()
        ? { kind: "file", rel, present: true, symlinkTarget: fs.readlinkSync(abs) }
        : {
            kind: "file",
            rel,
            present: true,
            contentRef: ctx.snapshots.putBlob(fs.readFileSync(abs)),
          };
      return ctx.snapshots.putRecord(pre, { connector: "filesystem", tool: "delete_file" });
    },
    async undo(entry, ctx) {
      return restoreFile(sandbox, getPreState<FilePreState>(entry, ctx), ctx);
    },
  };

  const deleteDirCompensator: Compensator = {
    async capture(args, ctx) {
      const rel = str(args, "path");
      const pre = captureTree(sandbox, rel, ctx);
      return ctx.snapshots.putRecord(pre, {
        kind: "tree",
        connector: "filesystem",
        tool: "delete_dir",
      });
    },
    async undo(entry, ctx) {
      return restoreTree(sandbox, getPreState<TreePreState>(entry, ctx), ctx);
    },
  };

  const manifest: CapabilityManifest = {
    connector: "filesystem",
    holdThreshold: options.holdThreshold ?? 25,
    tools: {
      read_file: {
        class: "read",
        summarize: (a) => `Read file ${a.path as string}`,
      },
      list_dir: {
        class: "read",
        summarize: (a) => `Listed directory ${a.path as string}`,
      },
      write_file: {
        class: "reversible",
        compensator: writeFileCompensator,
        blastRadius: () => 1,
        summarize: (a) => `Wrote file ${a.path as string}`,
      },
      move: {
        class: "reversible",
        compensator: moveCompensator,
        blastRadius: (a) => Math.max(1, countFiles(sandbox, a.src as string)),
        summarize: (a) => `Moved ${a.src as string} → ${a.dest as string}`,
      },
      delete_file: {
        class: "destructive",
        compensator: deleteFileCompensator,
        blastRadius: () => 1,
        summarize: (a) => `Deleted file ${a.path as string}`,
      },
      delete_dir: {
        class: "destructive",
        compensator: deleteDirCompensator,
        blastRadius: (a) => countFiles(sandbox, a.path as string),
        summarize: (a) => `Deleted directory ${a.path as string}`,
      },
    },
  };

  return { manifest, sandbox };
}
