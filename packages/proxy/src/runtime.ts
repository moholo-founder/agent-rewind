import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
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
} from "@backstop/core";

/**
 * BackstopRuntime — the choke point every agent action flows through.
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

export class BackstopRuntime {
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
    const blastRadius = cap?.blastRadius
      ? await cap.blastRadius(args, this.contextFor(route.connector))
      : 1;
    const riskScore = cap?.riskScore ?? defaultRiskScore(toolClass);
    const summary = cap?.summarize?.(args) ?? `${manifest.connector}.${tool}`;
    const argsRedacted = redactArgs(args, cap?.redactFields ?? []);

    const decision = gate({
      manifest,
      tool,
      toolClass,
      blastRadius,
      stopped: this.journal.isStopped(),
    });

    switch (decision.verdict) {
      case "pass-read": {
        // Pure pass-through: no gating, no snapshot. Journal after the fact.
        const result = await route.connector.client.callTool({
          name: tool,
          arguments: args,
        });
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
              text: "Backstop kill switch is engaged. All side-effecting actions are refused until a human operator resumes.",
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

    // 1. Capture pre-state BEFORE executing. If capture fails we do not
    //    execute: an action we can't undo must not run silently.
    let preStateRef: string | null = null;
    if (route.capability?.compensator) {
      try {
        preStateRef = await route.capability.compensator.capture(args, ctx);
      } catch (err) {
        const detail = `Pre-state capture failed, action refused: ${err instanceof Error ? err.message : String(err)}`;
        const action = existingActionId
          ? this.journal.transition(existingActionId, "failed", { resultSummary: detail })
          : this.journal.record({
              sessionId: this.sessionId,
              connector: manifest.connector,
              tool,
              argsRedacted: meta.argsRedacted,
              class: meta.toolClass,
              riskScore: meta.riskScore,
              blastRadius: meta.blastRadius,
              status: "failed",
              resultSummary: detail,
            });
        this.emit({ type: existingActionId ? "status" : "action", action });
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

    // 3. Journal.
    const executedTs = new Date().toISOString();
    const summaryText = failure ? `${meta.summary} — FAILED: ${failure}` : meta.summary;
    const action = existingActionId
      ? this.journal.transition(existingActionId, failure ? "failed" : "executed", {
          executedTs,
          preStateRef,
          resultSummary: summaryText,
        })
      : this.journal.record({
          sessionId: this.sessionId,
          connector: manifest.connector,
          tool,
          argsRedacted: meta.argsRedacted,
          class: meta.toolClass,
          riskScore: meta.riskScore,
          blastRadius: meta.blastRadius,
          status: failure ? "failed" : "executed",
          executedTs,
          preStateRef,
          resultSummary: summaryText,
        });
    this.emit({ type: existingActionId ? "status" : "action", action });

    return {
      action,
      content: result.content as ToolCallOutcome["content"],
      ...(result.isError ? { isError: true } : {}),
    };
  }

  // ---- held-action decisions ----------------------------------------------

  async approveHeld(actionId: string): Promise<ToolCallOutcome> {
    const action = this.journal.get(actionId);
    if (action.status !== "held") {
      throw new Error(`Action ${actionId} is not held (status: ${action.status})`);
    }
    // STOP also vetoes approvals: an operator must resume first.
    if (this.journal.isStopped()) {
      throw new Error("Kill switch is engaged; resume before approving actions.");
    }
    const args = this.pendingArgs.get(actionId);
    if (!args) {
      const failed = this.journal.transition(actionId, "rejected", {
        resultSummary: `${action.resultSummary ?? action.tool} — cannot execute: original arguments were lost (runtime restarted). Rejected for safety.`,
      });
      this.emit({ type: "status", action: failed });
      throw new Error("Original arguments no longer available; action rejected.");
    }
    const route = this.routes.get(action.tool);
    if (!route) throw new Error(`No route for tool ${action.tool}`);
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
      const updated = this.journal.transition(
        action.id,
        undoOk ? "undone" : "undo-failed",
        { resultSummary: result.detail },
      );
      this.emit({ type: "status", action: updated });
    }
    return result;
  }

  /** Rewind: undo everything executed after the anchor, LIFO. */
  async rewind(anchorIso: string): Promise<RewindReport> {
    const report = await executeRewind({
      journal: this.journal,
      anchorIso,
      runUndo: (action) => this.performUndo(action),
      onOutcome: (action) => this.emit({ type: "status", action }),
    });
    this.emit({ type: "rewind", rewind: report });
    return report;
  }

  async close(): Promise<void> {
    for (const reg of this.connectors.values()) {
      await reg.client.close().catch(() => {});
    }
    this.journal.close();
  }
}
