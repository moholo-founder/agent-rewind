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
      : handlePost(input, journal, opts.home);
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
      escalate = `Agent Rewind: this command matches a high-risk pattern (${hit}). It is journaled but has NO automatic undo — confirm deliberately.`;
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

function handlePost(input: HookInput, journal: Journal, home: string): HookResult {
  const tool = input.tool_name!;
  const args = input.tool_input ?? {};
  const summary = summarize(tool, args);
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
      journal.transition(actionId, "executed", {
        executedTs: new Date().toISOString(),
        resultSummary: summary,
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
