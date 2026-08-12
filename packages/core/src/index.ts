/**
 * @backstop/core — journal, snapshot store, policy engine, reversibility model.
 *
 * M0 stub: only the shared type vocabulary lives here so other packages can
 * compile against it. Implementations arrive in M1.
 */

/** How a tool call is classified by its connector's capability manifest. */
export type ActionClass = "read" | "reversible" | "destructive" | "unknown";

/** Lifecycle status of a journaled action. Append-only: status transitions
 *  are recorded as new compensating entries, never by mutating old rows. */
export type ActionStatus =
  | "executed"
  | "held"
  | "blocked-by-stop"
  | "rejected"
  | "undone"
  | "undo-failed";

/** Honest per-action outcome of an undo attempt. `partial` and `failed`
 *  must surface details — never report success that didn't happen. */
export interface UndoResult {
  outcome: "undone" | "failed" | "partial" | "not-reversible";
  detail: string;
}

export const CORE_PACKAGE = "@backstop/core";
