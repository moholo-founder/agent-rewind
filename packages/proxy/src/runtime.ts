import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  defaultRiskScore,
  executeRewind,
  gate,
  Journal,
  redactArgs,
  SnapshotStore,
  type ActionRecord,
  type CapabilityManifest,
  type CompensatorContext,
  type RewindReport,
  type TimelineEvent,
  type ToolCapability,
  type UndoResult,
} from "@agentrewind/core";

/**
 * AgentRewindRuntime — the choke point every agent action flows through.
 *
 * Owns the journal, snapshot store, connector manifests, downstream MCP
 * clients, the STOP flag, the held-action queue, and undo/rewind execution.
 * The MCP proxy server and the HTTP API are both thin shells over this.
 */

export interface ToolCallOutcome {
  /** What to return to the agent over MCP. */
  content: { type: "text"; text: string }[];
  isError?: boolean;
  /** The journal entry for this call. */
  action: ActionRecord;
}

interface ConnectorRegistration {
  manifest: CapabilityManifest;
  client: Client;
  /** Agent-visible tool descriptors, as listed by the downstream server. */
  tools: { name: string; description?: string; inputSchema: unknown }[];
}

interface RouteEntry {
  connector: ConnectorRegistration;
  capability: ToolCapability | undefined;
}

/** Recorded file effects of a hook-captured Bash command (see hooks mode). */
interface CcBashEffect {
  kind: "cc-bash-effect";
  root: string;
  modified: { rel: string; hash: string }[];
  deleted: { rel: string; hash: string }[];
  created: string[];
  skippedNote: string;
}

export class AgentRewindRuntime {
  readonly journal: Journal;
  readonly snapshots: SnapshotStore;
  readonly events = new EventEmitter();
  readonly sessionId = randomUUID();

  private readonly connectors = new Map<string, ConnectorRegistration>();
  private readonly routes = new Map<string, RouteEntry>();
  /**
   * Raw (unredacted) args for held actions, kept in memory only: the journal
   * must stay secret-free, but approval needs the original payload. If the
   * runtime restarts, held actions can no longer execute and must be
   * rejected — safe by construction.
   */
  private readonly pendingArgs = new Map<string, Record<string, unknown>>();

  constructor(opts: { dbPath: string; snapshotDir: string }) {
    this.journal = new Journal(opts.dbPath);
    this.snapshots = new SnapshotStore(opts.snapshotDir, this.journal);
  }

  private emit(event: TimelineEvent): void {
    this.events.emit("timeline", event);
  }

  // ---- connector registration --------------------------------------------

  async registerConnector(manifest: CapabilityManifest, client: Client): Promise<void> {
    const listed = await client.listTools();
    const adminPrefix = manifest.adminToolPrefix;
    const tools = listed.tools
      .filter((t) => !adminPrefix || !t.name.startsWith(adminPrefix))
      .map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: t.inputSchema,
      }));
    const reg: ConnectorRegistration = { manifest, client, tools };
    this.connectors.set(manifest.connector, reg);
    for (const t of listed.tools) {
      // Admin (compensator-only) tools get NO route at all — not merely a
      // hidden listing. With a route they would land in the held queue and a
      // single operator Approve would execute the surface the agent is never
      // supposed to reach. Compensators call downstream via the client
      // directly, so they don't need routes.
      if (adminPrefix && t.name.startsWith(adminPrefix)) continue;
      if (this.routes.has(t.name)) {
        throw new Error(
          `Tool name collision: "${t.name}" is exposed by two connectors`,
        );
      }
      this.routes.set(t.name, { connector: reg, capability: manifest.tools[t.name] });
    }
  }

  listToolsForAgent(): { name: string; description?: string; inputSchema: unknown }[] {
    return [...this.connectors.values()].flatMap((c) => c.tools);
  }

  private contextFor(reg: ConnectorRegistration): CompensatorContext {
    return {
      snapshots: this.snapshots,
      callDownstream: async (tool, args) => {
        const result = await reg.client.callTool({ name: tool, arguments: args });
        if (result.isError) {
          const text = Array.isArray(result.content)
            ? result.content
                .map((c) => (c as { text?: string }).text ?? "")
                .join("\n")
            : String(result.content);
          throw new Error(`Downstream ${tool} failed: ${text}`);
        }
        return result;
      },
    };
  }

  // ---- the gate ------------------------------------------------------------

  async handleToolCall(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallOutcome> {
    const route = this.routes.get(tool);

    // A tool no connector even exposes: nothing to execute now or later.
    if (!route) {
      const action = this.journal.record({
        sessionId: this.sessionId,
        connector: "unknown",
        tool,
        argsRedacted: redactArgs(args),
        class: "unknown",
        riskScore: 1,
        blastRadius: 0,
        status: "rejected",
        resultSummary: "No connector exposes this tool",
      });
      this.emit({ type: "action", action });
      return {
        action,
        isError: true,
        content: [{ type: "text", text: `Unknown tool "${tool}" — refused.` }],
      };
    }

    const { manifest } = route.connector;
    const cap = route.capability;
    const toolClass = cap?.class ?? "unknown";
    const riskScore = cap?.riskScore ?? defaultRiskScore(toolClass);
    let summary: string;
    try {
      summary = cap?.summarize?.(args) ?? `${manifest.connector}.${tool}`;
    } catch {
      summary = `${manifest.connector}.${tool}`;
    }
    const argsRedacted = redactArgs(args, cap?.redactFields ?? []);
    const stopped = this.journal.isStopped();

    // Blast-radius probe. Two rules learned the hard way:
    //  1. Never probe while STOPPED — the probe itself can be a downstream
    //     call, and the kill switch means NO side channels.
    //  2. A probe failure must be journaled and refused, not thrown raw: a
    //     sandbox-escape attempt (delete_dir "..") throws exactly here, and
    //     the flight recorder must capture exactly that.
    let blastRadius = 1;
    if (cap?.blastRadius && toolClass !== "read" && !stopped) {
      try {
        blastRadius = Number(
          await cap.blastRadius(args, this.contextFor(route.connector)),
        );
      } catch (err) {
        const detail = `Refused before execution: blast-radius probe failed — ${err instanceof Error ? err.message : String(err)}`;
        const action = this.journal.record({
          sessionId: this.sessionId,
          connector: manifest.connector,
          tool,
          argsRedacted,
          class: toolClass,
          riskScore,
          blastRadius: 0,
          status: "rejected",
          resultSummary: `${summary} — ${detail}`,
        });
        this.emit({ type: "action", action });
        return { action, isError: true, content: [{ type: "text", text: detail }] };
      }
    }

    const decision = gate({
      manifest,
      tool,
      toolClass,
      blastRadius,
      stopped,
    });

    switch (decision.verdict) {
      case "pass-read": {
        // Pure pass-through: no gating, no snapshot. Journal after the fact —
        // including transport failures, so "every action is journaled" holds
        // even when the downstream child is dead.
        let result: Awaited<ReturnType<Client["callTool"]>>;
        try {
          result = await route.connector.client.callTool({
            name: tool,
            arguments: args,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          result = { content: [{ type: "text", text: detail }], isError: true };
        }
        const action = this.journal.record({
          sessionId: this.sessionId,
          connector: manifest.connector,
          tool,
          argsRedacted,
          class: "read",
          riskScore: 0,
          blastRadius: 0,
          status: result.isError ? "failed" : "executed",
          executedTs: new Date().toISOString(),
          resultSummary: summary,
        });
        this.emit({ type: "action", action });
        return {
          action,
          content: result.content as ToolCallOutcome["content"],
          ...(result.isError ? { isError: true } : {}),
        };
      }

      case "block-stop": {
        const action = this.journal.record({
          sessionId: this.sessionId,
          connector: manifest.connector,
          tool,
          argsRedacted,
          class: toolClass,
          riskScore,
          blastRadius,
          status: "blocked-by-stop",
          resultSummary: `${summary} — BLOCKED: kill switch is engaged`,
        });
        this.emit({ type: "action", action });
        return {
          action,
          isError: true,
          content: [
            {
              type: "text",
              text: "Agent Rewind kill switch is engaged. All side-effecting actions are refused until a human operator resumes.",
            },
          ],
        };
      }

      case "hold": {
        const action = this.journal.record({
          sessionId: this.sessionId,
          connector: manifest.connector,
          tool,
          argsRedacted,
          class: toolClass,
          riskScore,
          blastRadius,
          status: "held",
          resultSummary: `${summary} — HELD: ${decision.reason}`,
        });
        this.pendingArgs.set(action.id, args);
        this.emit({ type: "action", action });
        return {
          action,
          isError: true,
          content: [
            {
              type: "text",
              text: `Action held for human approval (${decision.reason}). It has NOT executed. Action id: ${action.id}.`,
            },
          ],
        };
      }

      case "block-unknown-tool": {
        const action = this.journal.record({
          sessionId: this.sessionId,
          connector: manifest.connector,
          tool,
          argsRedacted,
          class: toolClass,
          riskScore,
          blastRadius,
          status: "rejected",
          resultSummary: `${summary} — ${decision.reason}`,
        });
        this.emit({ type: "action", action });
        return {
          action,
          isError: true,
          content: [{ type: "text", text: decision.reason }],
        };
      }

      case "execute":
        return this.captureAndExecute(route, tool, args, {
          argsRedacted,
          toolClass,
          riskScore,
          blastRadius,
          summary,
        });
    }
  }

  private async captureAndExecute(
    route: RouteEntry,
    tool: string,
    args: Record<string, unknown>,
    meta: {
      argsRedacted: unknown;
      toolClass: ActionRecord["class"];
      riskScore: number;
      blastRadius: number;
      summary: string;
    },
    existingActionId?: string,
  ): Promise<ToolCallOutcome> {
    const { manifest } = route.connector;
    const ctx = this.contextFor(route.connector);

    // 0. Record INTENT before any side effect. If we crash between the
    //    downstream call and its bookkeeping, the journal shows a pending
    //    destructive action instead of showing nothing at all — an executed
    //    action with zero journal trace would be invisible to Rewind forever.
    const actionId =
      existingActionId ??
      this.journal.record({
        sessionId: this.sessionId,
        connector: manifest.connector,
        tool,
        argsRedacted: meta.argsRedacted,
        class: meta.toolClass,
        riskScore: meta.riskScore,
        blastRadius: meta.blastRadius,
        status: "pending",
        resultSummary: `${meta.summary} — pending`,
      }).id;
    if (!existingActionId) {
      this.emit({ type: "action", action: this.journal.get(actionId) });
    }

    // 1. Capture pre-state BEFORE executing. If capture fails we do not
    //    execute: an action we can't undo must not run silently.
    let preStateRef: string | null = null;
    if (route.capability?.compensator) {
      try {
        preStateRef = await route.capability.compensator.capture(args, ctx);
      } catch (err) {
        const detail = `Pre-state capture failed, action refused: ${err instanceof Error ? err.message : String(err)}`;
        const action = this.journal.transition(actionId, "failed", {
          resultSummary: `${meta.summary} — ${detail}`,
        });
        this.emit({ type: "status", action });
        return { action, isError: true, content: [{ type: "text", text: detail }] };
      }
    }

    // 2. Execute downstream.
    let result: Awaited<ReturnType<Client["callTool"]>>;
    let failure: string | null = null;
    try {
      result = await route.connector.client.callTool({ name: tool, arguments: args });
      if (result.isError) {
        failure = (result.content as { text?: string }[])
          .map((c) => c.text ?? "")
          .join("\n");
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      result = { content: [{ type: "text", text: failure }], isError: true };
    }

    // 3. Journal the outcome (the intent row already exists).
    const executedTs = new Date().toISOString();
    const summaryText = failure ? `${meta.summary} — FAILED: ${failure}` : meta.summary;
    const action = this.journal.transition(actionId, failure ? "failed" : "executed", {
      executedTs,
      preStateRef,
      resultSummary: summaryText,
    });
    this.emit({ type: "status", action });

    return {
      action,
      content: result.content as ToolCallOutcome["content"],
      ...(result.isError ? { isError: true } : {}),
    };
  }

  // ---- held-action decisions ----------------------------------------------

  async approveHeld(actionId: string): Promise<ToolCallOutcome> {
    const action = this.journal.get(actionId);
    // STOP also vetoes approvals: an operator must resume first. Checked
    // before claiming so the row stays held (approvable after resume).
    if (this.journal.isStopped()) {
      throw new Error("Kill switch is engaged; resume before approving actions.");
    }
    // Atomically CLAIM the action (held → pending) before the first await.
    // The transition's status-guarded UPDATE makes a concurrent second
    // approval (or a reject) lose cleanly here instead of double-executing
    // or mis-journaling an executed action as rejected.
    let claimed: ActionRecord;
    try {
      claimed = this.journal.transition(actionId, "pending");
    } catch {
      throw new Error(
        `Action ${actionId} is not held (status: ${this.journal.get(actionId).status})`,
      );
    }
    this.emit({ type: "status", action: claimed });

    const args = this.pendingArgs.get(actionId);
    if (!args) {
      const failed = this.journal.transition(actionId, "rejected", {
        resultSummary: `${action.resultSummary ?? action.tool} — cannot execute: original arguments were lost (runtime restarted). Rejected for safety.`,
      });
      this.emit({ type: "status", action: failed });
      throw new Error("Original arguments no longer available; action rejected.");
    }
    const route = this.routes.get(action.tool);
    if (!route) {
      const failed = this.journal.transition(actionId, "rejected", {
        resultSummary: `${action.resultSummary ?? action.tool} — no route for this tool; rejected.`,
      });
      this.emit({ type: "status", action: failed });
      throw new Error(`No route for tool ${action.tool}`);
    }
    this.pendingArgs.delete(actionId);
    return this.captureAndExecute(
      route,
      action.tool,
      args,
      {
        argsRedacted: action.argsRedacted,
        toolClass: action.class,
        riskScore: action.riskScore,
        blastRadius: action.blastRadius,
        summary: (action.resultSummary ?? action.tool).replace(/ — HELD:.*$/, ""),
      },
      actionId,
    );
  }

  rejectHeld(actionId: string): ActionRecord {
    const action = this.journal.get(actionId);
    if (action.status !== "held") {
      throw new Error(`Action ${actionId} is not held (status: ${action.status})`);
    }
    this.pendingArgs.delete(actionId);
    const updated = this.journal.transition(actionId, "rejected", {
      resultSummary: `${(action.resultSummary ?? action.tool).replace(/ — HELD:.*$/, "")} — rejected by operator`,
    });
    this.emit({ type: "status", action: updated });
    return updated;
  }

  // ---- STOP / kill switch ---------------------------------------------------

  stop(): void {
    this.journal.setStopped(true);
    this.emit({ type: "stop", stopped: true });
  }

  resume(): void {
    this.journal.setStopped(false);
    this.emit({ type: "stop", stopped: false });
  }

  isStopped(): boolean {
    return this.journal.isStopped();
  }

  // ---- undo / rewind --------------------------------------------------------

  private async performUndo(action: ActionRecord): Promise<UndoResult> {
    // Actions captured by the Claude Code hooks (native Bash/Edit/Write)
    // have no connector route; file edits carry a cc-file snapshot and are
    // restored directly, shell commands are honestly not reversible.
    if (action.connector === "claude-code") {
      return this.undoClaudeCodeAction(action);
    }
    const route = this.routes.get(action.tool);
    const compensator = route?.capability?.compensator;
    if (!route || !compensator) {
      return {
        outcome: "not-reversible",
        detail: `No compensator is registered for ${action.connector}.${action.tool}`,
      };
    }
    return compensator.undo(action, this.contextFor(route.connector));
  }

  private undoClaudeCodeAction(action: ActionRecord): UndoResult {
    if (!action.preStateRef) {
      return {
        outcome: "not-reversible",
        detail:
          "Shell commands have no automatic inverse — recover via git, backups, or a filesystem snapshot. File edits made with Edit/Write ARE undoable.",
      };
    }
    const pre = this.snapshots.getRecord<{
      kind: string;
      path: string;
      present: boolean;
      contentRef?: string;
    }>(action.preStateRef);
    if (pre.kind === "cc-bash-effect") {
      return this.undoBashEffect(pre as unknown as CcBashEffect);
    }
    if (pre.kind === "cc-bash-tree") {
      // Pre-command manifest exists but the post-command diff never ran
      // (crash/denial mid-flight): there is no recorded effect set to
      // restore, and guessing would risk clobbering later work.
      return {
        outcome: "not-reversible",
        detail:
          "A pre-command tree snapshot exists but the command's completion was never observed, so its exact file effects are unknown. Not restoring blindly.",
      };
    }
    if (pre.kind !== "cc-file") {
      return { outcome: "failed", detail: `Unrecognized pre-state kind "${pre.kind}"` };
    }
    // Operator-initiated restore of the user's own edit history: absolute
    // paths are intentional here (hooks capture edits anywhere the user let
    // Claude Code write).
    if (pre.present) {
      fs.mkdirSync(path.dirname(pre.path), { recursive: true });
      fs.writeFileSync(pre.path, this.snapshots.getBlob(pre.contentRef ?? ""));
      return { outcome: "undone", detail: `Restored prior content of ${pre.path}` };
    }
    if (fs.existsSync(pre.path)) fs.rmSync(pre.path);
    return { outcome: "undone", detail: `Removed ${pre.path} (did not exist before)` };
  }

  /** Restore a Bash command's recorded file effects inside the project tree. */
  private undoBashEffect(effect: CcBashEffect): UndoResult {
    const root = path.resolve(effect.root);
    const resolveInRoot = (rel: string): string => {
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        throw new Error(`Effect path escapes project root: ${rel}`);
      }
      return abs;
    };
    let restored = 0, removed = 0;
    const failures: string[] = [];
    for (const { rel, hash } of [...effect.modified, ...effect.deleted]) {
      try {
        const abs = resolveInRoot(rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, this.snapshots.getBlob(hash));
        restored++;
      } catch (err) {
        failures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const rel of effect.created) {
      try {
        const abs = resolveInRoot(rel);
        if (fs.existsSync(abs)) fs.rmSync(abs);
        removed++;
      } catch (err) {
        failures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const scope = effect.skippedNote ? `; out of scope: ${effect.skippedNote}` : "";
    const total = effect.modified.length + effect.deleted.length + effect.created.length;
    if (total === 0) {
      return { outcome: "undone", detail: "Command had no recorded file effects in the project (processes/network are not reversible)" };
    }
    if (failures.length === 0) {
      return {
        outcome: "undone",
        detail: `Restored ${restored} files, removed ${removed} created files (file effects only — processes/network are not reversible${scope})`,
      };
    }
    return {
      outcome: restored + removed > 0 ? "partial" : "failed",
      detail: `Restored ${restored}/${effect.modified.length + effect.deleted.length}, removed ${removed}/${effect.created.length}; failures: ${failures.slice(0, 3).join("; ")}`,
    };
  }

  /** Undo a single executed action (timeline Undo button). */
  async undoAction(actionId: string): Promise<UndoResult> {
    const action = this.journal.get(actionId);
    if (action.status !== "executed" && action.status !== "undo-failed") {
      return {
        outcome: "not-reversible",
        detail: `Action is ${action.status}; only executed actions can be undone.`,
      };
    }
    let result: UndoResult;
    try {
      result = await this.performUndo(action);
    } catch (err) {
      result = {
        outcome: "failed",
        detail: `Undo threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const undoOk = result.outcome === "undone";
    const comp = this.journal.record({
      sessionId: this.sessionId,
      connector: action.connector,
      tool: `undo:${action.tool}`,
      argsRedacted: { originalActionId: action.id },
      class: "reversible",
      riskScore: 0,
      blastRadius: action.blastRadius,
      status: undoOk ? "executed" : "failed",
      executedTs: new Date().toISOString(),
      resultSummary: result.detail,
      causedBy: action.id,
    });
    this.emit({ type: "action", action: comp });
    if (result.outcome !== "not-reversible") {
      try {
        const updated = this.journal.transition(
          action.id,
          undoOk ? "undone" : "undo-failed",
          { resultSummary: result.detail },
        );
        this.emit({ type: "status", action: updated });
      } catch {
        // Raced by a concurrent rewind/undo. If the row already carries the
        // status we wanted, the world and journal agree — nothing to do.
        const now = this.journal.get(action.id);
        this.emit({ type: "status", action: now });
        if (now.status !== (undoOk ? "undone" : "undo-failed")) {
          return {
            outcome: "partial",
            detail: `${result.detail} — but the journal row changed concurrently (now ${now.status})`,
          };
        }
      }
    }
    return result;
  }

  /**
   * Rewind: undo everything executed after the anchor (or exactly the
   * previewed set when `onlyActionIds` is given), LIFO.
   *
   * The kill switch is engaged for the duration: an agent acting mid-rewind
   * would otherwise have its fresh writes clobbered by pre-plan snapshot
   * restores while the report claims full restoration. If the operator had
   * already stopped, we leave the switch tripped afterwards.
   */
  async rewind(anchorIso: string, onlyActionIds?: readonly string[]): Promise<RewindReport> {
    const wasStopped = this.isStopped();
    if (!wasStopped) this.stop();
    try {
      const report = await executeRewind({
        journal: this.journal,
        anchorIso,
        runUndo: (action) => this.performUndo(action),
        ...(onlyActionIds ? { onlyActionIds } : {}),
        onOutcome: (action) => this.emit({ type: "status", action }),
      });
      this.emit({ type: "rewind", rewind: report });
      return report;
    } finally {
      if (!wasStopped) this.resume();
    }
  }

  async close(): Promise<void> {
    for (const reg of this.connectors.values()) {
      await reg.client.close().catch(() => {});
    }
    this.journal.close();
  }
}
