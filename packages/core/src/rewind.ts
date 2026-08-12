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
 *
 * Concurrency honesty: each action is re-read at its turn — a row a
 * concurrent single-undo already flipped is reported as already-undone
 * rather than re-run, and a transition raced by another writer downgrades
 * that one outcome instead of aborting the whole rewind.
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
  /**
   * When provided, only these action ids are undone (the set the operator
   * previewed and confirmed) — actions executed between preview and confirm
   * are NOT silently swept in.
   */
  onlyActionIds?: readonly string[];
  /** Called after each action's outcome is journaled (drives live UI). */
  onOutcome?: (action: ActionRecord, result: UndoResult) => void;
}): Promise<RewindReport> {
  const { journal, anchorIso, runUndo, onlyActionIds, onOutcome } = params;
  const startedTs = new Date().toISOString();
  let plan = planRewind(journal, anchorIso);
  if (onlyActionIds) {
    const wanted = new Set(onlyActionIds);
    plan = plan.filter((a) => wanted.has(a.id));
  }
  const outcomes: RewindReport["outcomes"] = [];

  for (const planned of plan) {
    // Re-read at execution time: the world may have moved since planning.
    const action = journal.get(planned.id);
    let result: UndoResult;
    if (action.status === "undone") {
      result = {
        outcome: "undone",
        detail: "Already undone before this rewind reached it",
      };
    } else if (action.status !== "executed" && action.status !== "undo-failed") {
      result = {
        outcome: "not-reversible",
        detail: `Status changed to ${action.status} since the rewind was planned; skipped`,
      };
    } else {
      try {
        result = await runUndo(action);
      } catch (err) {
        result = {
          outcome: "failed",
          detail: `Undo threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Journal a compensating entry linked to the original, then update the
      // original's lifecycle status. A failure in this bookkeeping downgrades
      // THIS action's outcome — it must never abort the remaining undos.
      try {
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
      } catch (err) {
        result = {
          outcome: result.outcome === "undone" ? "partial" : result.outcome,
          detail: `${result.detail} — BUT journaling the outcome failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    outcomes.push({
      actionId: action.id,
      connector: action.connector,
      tool: action.tool,
      summary: action.resultSummary ?? action.tool,
      outcome: result.outcome,
      detail: result.detail,
    });
    try {
      onOutcome?.(journal.get(action.id), result);
    } catch {
      // UI notification must never affect the rewind itself.
    }
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
