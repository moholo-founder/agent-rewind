import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  Journal,
  redactArgs,
  SnapshotStore,
  type ActionClass,
} from "@agentrewind/core";

/**
 * Claude Code hooks capture: flight-record NATIVE Claude Code tools
 * (Bash, Edit, Write, MultiEdit, NotebookEdit), which never pass through
 * the MCP proxy.
 *
 * Wire-up (see `agent-rewind hooks install`): Claude Code invokes
 * `agent-rewind hook` on PreToolUse and PostToolUse with a JSON payload on
 * stdin. Pre records intent (pending) and snapshots the file a file-editing
 * tool is about to change; Post transitions the row to executed. The STOP
 * flag in the shared journal DENIES every tracked tool — a kill switch that
 * works on native Claude Code sessions, outside the agent's context.
 *
 * Honesty notes:
 *  - Arbitrary Bash has no automatic inverse; it is journaled and gated
 *    (dangerous patterns escalate to a permission prompt) but undo is
 *    honestly "not-reversible". File edits ARE undoable via snapshots.
 *  - PostToolUse only fires on successful completion. Pending rows whose
 *    completion never arrives (denied by the user, crashed) are swept to
 *    `failed` with an explicit "no completion observed" summary.
 */

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
}

export interface HookResult {
  exitCode: number;
  stdout?: string;
}

const TRACKED = new Set(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Heuristic escalation list — gating aid, NOT a security boundary. */
const DANGEROUS_BASH: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\b|--recursive\b|--force\b)/i,
  /\bsudo\b/,
  /\bdd\b[^|]*\bof=/,
  /\bmkfs\b/,
  />+\s*\/dev\//,
  /\bgit\s+push\b.*(--force|-f\b)/,
  /\bchmod\b\s+-r/i,
  /\bcurl\b[^|]*\|\s*(ba|z)?sh\b/,
  /\b(shutdown|reboot|halt)\b/,
  /\bkill(all)?\s+-9\b/,
];

const PENDING_TTL_MS = 60 * 60 * 1000;

interface CcFilePreState {
  kind: "cc-file";
  path: string;
  present: boolean;
  contentRef?: string;
}

// ---- Bash tree snapshots ---------------------------------------------------
// Arbitrary shell has no inverse, but its FILE effects inside the project
// tree do: snapshot the tree before the command (content-addressed dedup +
// an mtime/size cache make repeats cheap), diff after, and undo restores
// exactly what the command touched. Processes, network, and paths outside
// the project root remain honestly out of scope.

const TREE_EXCLUDES = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", ".next",
  ".turbo", ".cache", ".venv", "venv", "__pycache__", "target",
  ".pnpm-store", ".DS_Store",
]);
const MAX_TREE_FILES = 20_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface TreeManifest {
  kind: "cc-bash-tree";
  root: string;
  /** rel path → snapshot blob ref (sha256). */
  files: Record<string, string>;
  fileCount: number;
  skippedLarge: number;
  skippedSymlinks: number;
}

interface BashEffect {
  kind: "cc-bash-effect";
  root: string;
  modified: { rel: string; hash: string }[];
  deleted: { rel: string; hash: string }[];
  created: string[];
  skippedNote: string;
}

interface CacheEntry { mtimeMs: number; size: number; hash: string; }

function treeCachePath(home: string, root: string): string {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return path.join(home, "tree-cache", `${key}.json`);
}

function shouldExclude(name: string): boolean {
  return TREE_EXCLUDES.has(name) || name.startsWith(".agent-rewind");
}

/**
 * Walk the tree building rel→blobRef. Uses the previous walk's mtime/size
 * cache so unchanged files are neither re-read nor re-hashed. Returns null
 * when the tree exceeds the file cap (capture is skipped, journaled as such).
 */
function captureTreeManifest(
  root: string,
  snapshots: SnapshotStore,
  home: string,
): TreeManifest | null {
  let cache: Record<string, CacheEntry> = {};
  const cacheFile = treeCachePath(home, root);
  try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<string, CacheEntry>; } catch { /* cold */ }
  const nextCache: Record<string, CacheEntry> = {};
  const files: Record<string, string> = {};
  let fileCount = 0, skippedLarge = 0, skippedSymlinks = 0;

  const walk = (dir: string, rel: string): boolean => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      if (shouldExclude(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink()) { skippedSymlinks++; continue; }
      if (e.isDirectory()) { if (!walk(abs, r)) return false; continue; }
      if (!e.isFile()) continue;
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) { skippedLarge++; continue; }
      if (++fileCount > MAX_TREE_FILES) return false;
      const cached = cache[r];
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && snapshots.has(cached.hash)) {
        files[r] = cached.hash;
        nextCache[r] = cached;
      } else {
        try {
          const hash = snapshots.putBlob(fs.readFileSync(abs), { origin: "cc-bash-tree" });
          files[r] = hash;
          nextCache[r] = { mtimeMs: st.mtimeMs, size: st.size, hash };
        } catch { /* unreadable file — skip */ }
      }
    }
    return true;
  };

  if (!walk(root, "")) return null;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(nextCache));
  } catch { /* cache is an optimization only */ }
  return { kind: "cc-bash-tree", root, files, fileCount, skippedLarge, skippedSymlinks };
}

/** Diff a fresh walk against the pre-command manifest. */
function diffTree(pre: TreeManifest, post: TreeManifest): BashEffect {
  const modified: BashEffect["modified"] = [];
  const deleted: BashEffect["deleted"] = [];
  const created: string[] = [];
  for (const [rel, hash] of Object.entries(pre.files)) {
    const now = post.files[rel];
    if (now === undefined) deleted.push({ rel, hash });
    else if (now !== hash) modified.push({ rel, hash });
  }
  for (const rel of Object.keys(post.files)) {
    if (pre.files[rel] === undefined) created.push(rel);
  }
  const notes: string[] = [];
  if (pre.skippedLarge || post.skippedLarge) notes.push(`${Math.max(pre.skippedLarge, post.skippedLarge)} files >5MB not covered`);
  if (pre.skippedSymlinks) notes.push(`${pre.skippedSymlinks} symlinks not covered`);
  return {
    kind: "cc-bash-effect",
    root: pre.root,
    modified,
    deleted,
    created,
    skippedNote: notes.join("; "),
  };
}

function pendingDir(home: string): string {
  return path.join(home, "hook-pending");
}

function correlationKey(input: HookInput): string {
  if (input.tool_use_id) return input.tool_use_id.replace(/[^\w-]/g, "_");
  // Fallback: parallel identical calls in one session may collide; the
  // consequence is a mis-paired post transition, never a lost journal row.
  return createHash("sha256")
    .update(`${input.session_id ?? ""}|${input.tool_name ?? ""}|${JSON.stringify(input.tool_input ?? {})}`)
    .digest("hex")
    .slice(0, 32);
}

function deny(reason: string): HookResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  };
}

function ask(reason: string): HookResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    }),
  };
}

function summarize(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "Bash":
      return `$ ${String(args.command ?? "").slice(0, 140)}`;
    case "Write":
      return `Wrote ${String(args.file_path ?? "?")}`;
    case "Edit":
      return `Edited ${String(args.file_path ?? "?")}`;
    case "MultiEdit":
      return `Edited ${String(args.file_path ?? "?")} (multi)`;
    case "NotebookEdit":
      return `Edited notebook ${String(args.notebook_path ?? "?")}`;
    default:
      return tool;
  }
}

function targetFile(tool: string, args: Record<string, unknown>): string | null {
  const p = tool === "NotebookEdit" ? args.notebook_path : args.file_path;
  return typeof p === "string" && p.length > 0 ? p : null;
}

/** Mark long-abandoned pending rows failed — completion never came. */
function sweepStale(journal: Journal, home: string): void {
  const dir = pendingDir(home);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < PENDING_TTL_MS) continue;
      const { actionId } = JSON.parse(fs.readFileSync(file, "utf8")) as { actionId: string };
      try {
        journal.transition(actionId, "failed", {
          resultSummary: "No completion observed (denied or interrupted) — swept",
        });
      } catch {
        /* already transitioned */
      }
      fs.rmSync(file);
    } catch {
      fs.rmSync(file, { force: true });
    }
  }
}

export function runHook(input: HookInput, opts: { home: string }): HookResult {
  const tool = input.tool_name ?? "";
  const event = input.hook_event_name ?? "";
  if (!TRACKED.has(tool)) return { exitCode: 0 };
  if (event !== "PreToolUse" && event !== "PostToolUse") return { exitCode: 0 };

  const journal = new Journal(path.join(opts.home, "journal.sqlite"));
  try {
    const snapshots = new SnapshotStore(path.join(opts.home, "snapshots"), journal);
    sweepStale(journal, opts.home);
    return event === "PreToolUse"
      ? handlePre(input, journal, snapshots, opts.home)
      : handlePost(input, journal, snapshots, opts.home);
  } finally {
    journal.close();
  }
}

function handlePre(
  input: HookInput,
  journal: Journal,
  snapshots: SnapshotStore,
  home: string,
): HookResult {
  const tool = input.tool_name!;
  const args = input.tool_input ?? {};
  const summary = summarize(tool, args);
  const argsRedacted = redactArgs(args);

  // The kill switch beats everything — including native Claude Code tools.
  if (journal.isStopped()) {
    journal.record({
      sessionId: input.session_id ?? "claude-code",
      connector: "claude-code",
      tool,
      argsRedacted,
      class: FILE_TOOLS.has(tool) ? "reversible" : "unknown",
      riskScore: 1,
      blastRadius: 1,
      status: "blocked-by-stop",
      resultSummary: `${summary} — BLOCKED: kill switch is engaged`,
    });
    return deny(
      "Agent Rewind kill switch is engaged: all side-effecting tools are refused until a human operator resumes (timeline UI or `agent-rewind ui`).",
    );
  }

  let toolClass: ActionClass = "unknown";
  let riskScore = 0.6;
  let preStateRef: string | null = null;
  let escalate: string | null = null;

  if (FILE_TOOLS.has(tool)) {
    toolClass = "reversible";
    riskScore = 0.4;
    const file = targetFile(tool, args);
    if (file) {
      // Snapshot BEFORE the edit so the timeline's Undo can restore it.
      try {
        const present = fs.existsSync(file);
        const pre: CcFilePreState = present
          ? { kind: "cc-file", path: file, present: true, contentRef: snapshots.putBlob(fs.readFileSync(file)) }
          : { kind: "cc-file", path: file, present: false };
        preStateRef = snapshots.putRecord(pre, { connector: "claude-code", tool });
      } catch (err) {
        // Fail open for capture (this is a recorder for native tools, not a
        // gate on them) but be loud in the journal about the gap.
        escalate = null;
        preStateRef = null;
        journal.record({
          sessionId: input.session_id ?? "claude-code",
          connector: "claude-code",
          tool,
          argsRedacted,
          class: toolClass,
          riskScore,
          blastRadius: 1,
          status: "failed",
          resultSummary: `${summary} — pre-state capture failed (${err instanceof Error ? err.message : String(err)}); edit NOT undoable`,
        });
      }
    }
  } else if (tool === "Bash") {
    const command = String(args.command ?? "");
    const hit = DANGEROUS_BASH.find((re) => re.test(command));
    if (hit) {
      toolClass = "destructive";
      riskScore = 0.9;
      escalate = `Agent Rewind: this command matches a high-risk pattern (${hit}). File effects inside the project are snapshotted, but processes/network are NOT undoable — confirm deliberately.`;
    }
    // Snapshot the project tree so the command's FILE effects are undoable.
    if (input.cwd && fs.existsSync(input.cwd)) {
      try {
        const manifest = captureTreeManifest(path.resolve(input.cwd), snapshots, home);
        if (manifest) {
          preStateRef = snapshots.putRecord(manifest, { connector: "claude-code", tool: "Bash" });
        }
      } catch {
        // Capture is best-effort for Bash: the command still runs, and undo
        // will honestly report not-reversible for this action.
        preStateRef = null;
      }
    }
  }

  const action = journal.record({
    sessionId: input.session_id ?? "claude-code",
    connector: "claude-code",
    tool,
    argsRedacted,
    class: toolClass,
    riskScore,
    blastRadius: 1,
    status: "pending",
    preStateRef,
    resultSummary: `${summary} — pending`,
  });

  fs.mkdirSync(pendingDir(home), { recursive: true });
  fs.writeFileSync(
    path.join(pendingDir(home), correlationKey(input)),
    JSON.stringify({ actionId: action.id, summary }),
  );

  return escalate ? ask(escalate) : { exitCode: 0 };
}

function handlePost(
  input: HookInput,
  journal: Journal,
  snapshots: SnapshotStore,
  home: string,
): HookResult {
  const tool = input.tool_name!;
  const args = input.tool_input ?? {};
  let summary = summarize(tool, args);
  const pendingFile = path.join(pendingDir(home), correlationKey(input));

  let actionId: string | null = null;
  if (fs.existsSync(pendingFile)) {
    try {
      actionId = (JSON.parse(fs.readFileSync(pendingFile, "utf8")) as { actionId: string }).actionId;
    } catch {
      /* corrupt pending file */
    }
    fs.rmSync(pendingFile, { force: true });
  }

  if (actionId) {
    try {
      // For Bash with a pre-command tree manifest: rewalk, diff, and swap the
      // pre-state ref for the concrete effect set (what to restore on undo).
      let preStateRef: string | undefined;
      if (tool === "Bash") {
        const row = journal.get(actionId);
        if (row.preStateRef) {
          try {
            const pre = snapshots.getRecord<TreeManifest>(row.preStateRef);
            if (pre.kind === "cc-bash-tree" && fs.existsSync(pre.root)) {
              const post = captureTreeManifest(pre.root, snapshots, home);
              if (post) {
                const effect = diffTree(pre, post);
                preStateRef = snapshots.putRecord(effect, { connector: "claude-code", tool: "Bash" });
                const touched = effect.modified.length + effect.created.length + effect.deleted.length;
                summary = touched
                  ? `${summary} — touched ${touched} files (${effect.modified.length} modified, ${effect.created.length} created, ${effect.deleted.length} deleted)`
                  : `${summary} — no file changes in project`;
              }
            }
          } catch { /* diff is best-effort; original manifest stays attached */ }
        }
      }
      journal.transition(actionId, "executed", {
        executedTs: new Date().toISOString(),
        resultSummary: summary,
        ...(preStateRef ? { preStateRef } : {}),
      });
      return { exitCode: 0 };
    } catch {
      /* row raced or already final — fall through to a fresh record */
    }
  }

  // No pre row (hook installed mid-session, or correlation missed):
  // journal the completion directly so nothing goes unrecorded.
  journal.record({
    sessionId: input.session_id ?? "claude-code",
    connector: "claude-code",
    tool,
    argsRedacted: redactArgs(args),
    class: FILE_TOOLS.has(tool) ? "reversible" : "unknown",
    riskScore: FILE_TOOLS.has(tool) ? 0.4 : 0.6,
    blastRadius: 1,
    status: "executed",
    executedTs: new Date().toISOString(),
    resultSummary: summary,
  });
  return { exitCode: 0 };
}
