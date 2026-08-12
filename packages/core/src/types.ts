/**
 * Shared type vocabulary for the Backstop reversibility model.
 */

/** How a tool call is classified by its connector's capability manifest. */
export type ActionClass = "read" | "reversible" | "destructive" | "unknown";

/**
 * Lifecycle status of a journaled action.
 *
 * `pending` is transient (row inserted before execution). `held` awaits a
 * human decision. Terminal-ish states: `executed` (may later become `undone`
 * or `undo-failed`), `blocked-by-stop`, `rejected`, `failed` (downstream
 * call errored).
 */
export type ActionStatus =
  | "pending"
  | "executed"
  | "failed"
  | "held"
  | "blocked-by-stop"
  | "rejected"
  | "undone"
  | "undo-failed";

/**
 * Honest per-action outcome of an undo attempt. `partial` and `failed`
 * must carry detail — the system never reports success that didn't happen.
 */
export interface UndoResult {
  outcome: "undone" | "failed" | "partial" | "not-reversible";
  detail: string;
}

/** A row in the append-only actions journal. */
export interface ActionRecord {
  id: string;
  /** When the action was journaled (ISO 8601). */
  ts: string;
  /**
   * When the action actually executed downstream (ISO 8601), if it did.
   * Held actions approved later execute out of journal order; rewind
   * ordering uses this, not `ts`.
   */
  executedTs: string | null;
  sessionId: string;
  connector: string;
  tool: string;
  /** Redacted argument payload — never contains secrets (see redact.ts). */
  argsRedacted: unknown;
  class: ActionClass;
  riskScore: number;
  blastRadius: number;
  preStateRef: string | null;
  status: ActionStatus;
  resultSummary: string | null;
  /** Links a compensating action (an undo) back to the original. */
  causedBy: string | null;
}

export type SnapshotKind = "blob" | "tree" | "record";

export interface SnapshotIndexEntry {
  ref: string;
  kind: SnapshotKind;
  bytes: number;
  createdTs: string;
  meta: Record<string, unknown>;
}

export interface RewindActionOutcome {
  actionId: string;
  connector: string;
  tool: string;
  summary: string;
  outcome: UndoResult["outcome"];
  detail: string;
}

export interface RewindReport {
  rewindId: string;
  anchor: string;
  startedTs: string;
  finishedTs: string;
  outcomes: RewindActionOutcome[];
  /** True only when every single outcome is `undone`. Honest by construction. */
  fullyRestored: boolean;
}

/**
 * Context handed to compensators. They may snapshot state and/or invoke
 * downstream tools (e.g. admin-only tools the agent never sees).
 */
export interface CompensatorContext {
  snapshots: SnapshotStoreLike;
  /** Invoke a tool on the connector's downstream MCP server. */
  callDownstream(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface Compensator {
  /**
   * Snapshot whatever the action will overwrite/destroy. Runs strictly
   * before execution. Returns a snapshot ref, or null when there is no
   * pre-state to capture (e.g. creating a brand-new file).
   */
  capture(
    args: Record<string, unknown>,
    ctx: CompensatorContext,
  ): Promise<string | null>;
  /**
   * Restore from captured state (or issue the inverse operation).
   * Must be idempotent and report honest success/failure/partial.
   */
  undo(entry: ActionRecord, ctx: CompensatorContext): Promise<UndoResult>;
}

/** Declaration for a single tool exposed by a connector. */
export interface ToolCapability {
  class: ActionClass;
  /** Required for every non-read tool. */
  compensator?: Compensator;
  /** Magnitude of the action (file count, recipient count, ...). Default 1. */
  blastRadius?(
    args: Record<string, unknown>,
    ctx: CompensatorContext,
  ): number | Promise<number>;
  /** 0..1 heuristic used for display; defaults derived from class. */
  riskScore?: number;
  /** Human-readable summary for the timeline ("Deleted 200 files in /x"). */
  summarize?(args: Record<string, unknown>): string;
  /** Field names to redact from the journal beyond the global defaults. */
  redactFields?: string[];
}

/** Per-connector capability manifest: tool name → declaration. */
export interface CapabilityManifest {
  connector: string;
  tools: Record<string, ToolCapability>;
  /**
   * Blast-radius threshold: actions with blastRadius > holdThreshold are
   * held for human approval before executing.
   */
  holdThreshold: number;
  /**
   * Downstream tools with this prefix are for compensators only: hidden
   * from the agent's tool list and refused if the agent calls them anyway.
   */
  adminToolPrefix?: string;
}

/** What the policy gate decided for an incoming call. */
export type GateDecision =
  | { verdict: "pass-read" }
  | { verdict: "execute" }
  | { verdict: "hold"; reason: string }
  | { verdict: "block-stop" }
  | { verdict: "block-unknown-tool"; reason: string };

/** Minimal snapshot-store surface compensators depend on. */
export interface SnapshotStoreLike {
  putBlob(content: Buffer, meta?: Record<string, unknown>): string;
  putRecord(value: unknown, meta?: Record<string, unknown>): string;
  getBlob(ref: string): Buffer;
  getRecord<T = unknown>(ref: string): T;
  has(ref: string): boolean;
}

/** Event emitted whenever the journal changes; feeds the SSE stream. */
export interface TimelineEvent {
  type: "action" | "status" | "stop" | "rewind";
  action?: ActionRecord;
  stopped?: boolean;
  rewind?: RewindReport;
}
