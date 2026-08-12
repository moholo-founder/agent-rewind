import { randomUUID } from "node:crypto";
import type { Journal } from "./journal.js";
import type {
  ActionRecord,
  RewindReport,
  UndoResult,
} from "./types.js";

/**
 * Rewind engine.
 *
 * Given an anchor timestamp, collect every executed side-effecting action
 * after it and undo them in strict LIFO order of execution time. Each undo
 * runs in its own try/catch: one failure never aborts the rest, and the
 * report states per-action truth. `fullyRestored` is true only when every
 * outcome is `undone` — the system never claims the world is restored when
 * it isn't.
 */

export interface UndoRunner {
  /** Perform the undo for one action. Throwing is treated as failure. */
  (action: ActionRecord): Promise<UndoResult>;
}

export function planRewind(journal: Journal, anchorIso: string): ActionRecord[] {
  return journal.listRewindable(anchorIso);
}

export async function executeRewind(params: {
  journal: Journal;
  anchorIso: string;
  runUndo: UndoRunner;
  /** Called after each action's outcome is journaled (drives live UI). */
  onOutcome?: (action: ActionRecord, result: UndoResult) => void;
}): Promise<RewindReport> {
  const { journal, anchorIso, runUndo, onOutcome } = params;
  const startedTs = new Date().toISOString();
  const plan = planRewind(journal, anchorIso);
  const outcomes: RewindReport["outcomes"] = [];

  for (const action of plan) {
    let result: UndoResult;
    try {
      result = await runUndo(action);
    } catch (err) {
      result = {
        outcome: "failed",
        detail: `Undo threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Journal a compensating entry linked to the original, then update the
    // original's lifecycle status. Originals are never rewritten beyond that.
    const undoOk = result.outcome === "undone";
    journal.record({
      sessionId: "rewind",
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
    if (result.outcome !== "not-reversible") {
      journal.transition(action.id, undoOk ? "undone" : "undo-failed", {
        resultSummary: result.detail,
      });
    }

    outcomes.push({
      actionId: action.id,
      connector: action.connector,
      tool: action.tool,
      summary: action.resultSummary ?? action.tool,
      outcome: result.outcome,
      detail: result.detail,
    });
    onOutcome?.(journal.get(action.id), result);
  }

  const report: RewindReport = {
    rewindId: randomUUID(),
    anchor: anchorIso,
    startedTs,
    finishedTs: new Date().toISOString(),
    outcomes,
    fullyRestored:
      outcomes.length > 0 && outcomes.every((o) => o.outcome === "undone"),
  };
  journal.recordRewind(report);
  return report;
}
