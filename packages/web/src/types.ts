/** Wire types mirrored from @backstop/core (kept dependency-free). */

export type ActionClass = "read" | "reversible" | "destructive" | "unknown";

export type ActionStatus =
  | "pending"
  | "executed"
  | "failed"
  | "held"
  | "blocked-by-stop"
  | "rejected"
  | "undone"
  | "undo-failed";

export interface ActionRecord {
  id: string;
  ts: string;
  executedTs: string | null;
  sessionId: string;
  connector: string;
  tool: string;
  argsRedacted: Record<string, unknown> | null;
  class: ActionClass;
  riskScore: number;
  blastRadius: number;
  preStateRef: string | null;
  status: ActionStatus;
  resultSummary: string | null;
  causedBy: string | null;
}

export interface RewindActionOutcome {
  actionId: string;
  connector: string;
  tool: string;
  summary: string;
  outcome: "undone" | "failed" | "partial" | "not-reversible";
  detail: string;
}

export interface RewindReport {
  rewindId: string;
  anchor: string;
  startedTs: string;
  finishedTs: string;
  outcomes: RewindActionOutcome[];
  fullyRestored: boolean;
}

export interface TimelineSnapshot {
  stopped: boolean;
  actions: ActionRecord[];
  held: ActionRecord[];
  rewinds: RewindReport[];
}

export interface TimelineEvent {
  type: "hello" | "action" | "status" | "stop" | "rewind";
  action?: ActionRecord;
  stopped?: boolean;
  rewind?: RewindReport;
}

export interface ActionDetail {
  action: ActionRecord;
  preState: (Record<string, unknown> & { kind: string }) | null;
}
