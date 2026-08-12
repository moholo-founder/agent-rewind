import { useState } from "react";
import { api } from "./api";
import { DiffView } from "./DiffView";
import type { ActionDetail, ActionRecord } from "./types";

function timeOf(a: ActionRecord): string {
  return new Date(a.executedTs ?? a.ts).toLocaleTimeString();
}

function cleanSummary(a: ActionRecord): string {
  return (a.resultSummary ?? `${a.connector}.${a.tool}`).replace(/ — HELD:.*$/, "");
}

const UNDOABLE = new Set(["executed", "undo-failed"]);

export function ActionRow({
  action,
  onRewindHere,
}: {
  action: ActionRecord;
  onRewindHere: (a: ActionRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ActionDetail | null>(null);
  const [undoNote, setUndoNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isCompensation = action.causedBy !== null;
  const canUndo =
    !isCompensation &&
    action.class !== "read" &&
    action.class !== "unknown" &&
    UNDOABLE.has(action.status);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      try {
        setDetail(await api.actionDetail(action.id));
      } catch {
        /* row stays open with args only */
      }
    }
  };

  const undo = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    setUndoNote(null);
    try {
      const { result } = await api.undo(action.id);
      if (result.outcome !== "undone") {
        setUndoNote(`${result.outcome.toUpperCase()}: ${result.detail}`);
      }
    } catch (err) {
      setUndoNote(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`row${isCompensation ? " compensation" : ""}`}>
      <div className="row-main" onClick={toggle}>
        <span className="t">{timeOf(action)}</span>
        <span className="connector">{action.connector}</span>
        <span className="summary">
          {isCompensation ? "↩︎ " : ""}
          {cleanSummary(action)}
          {undoNote && (
            <span className="detail-note" style={{ color: "var(--destructive)" }}>
              {" "}
              — {undoNote}
            </span>
          )}
        </span>
        <span className={`badge ${action.class}`}>{action.class}</span>
        <span className={`blast${action.blastRadius > 25 ? " big" : ""}`}>
          {action.class === "read" ? "" : `⌀ ${action.blastRadius}`}
        </span>
        <span className={`status ${action.status}`}>
          {action.status === "undo-failed" ? "⚠ undo failed" : action.status}
        </span>
      </div>
      {(canUndo || !isCompensation) && (
        <div className="row-actions" style={{ padding: "0 14px 10px" }}>
          {canUndo && (
            <button className="undo-btn" onClick={undo} disabled={busy}>
              {busy ? "undoing…" : action.status === "undo-failed" ? "↩︎ Retry undo" : "↩︎ Undo"}
            </button>
          )}
          {!isCompensation && action.executedTs && action.class !== "read" && (
            <button
              className="rewind-here-btn"
              onClick={(e) => {
                e.stopPropagation();
                onRewindHere(action);
              }}
            >
              ⏪ Rewind to before this
            </button>
          )}
        </div>
      )}
      {open && (
        <div className="row-detail">
          <div className="kv">
            id {action.id} · journaled {new Date(action.ts).toLocaleString()}
            {action.executedTs &&
              ` · executed ${new Date(action.executedTs).toLocaleString()}`}
            {action.causedBy && ` · compensates ${action.causedBy}`}
          </div>
          {action.status === "undo-failed" && (
            <div className="stop-banner" style={{ marginBottom: 10 }}>
              ⚠ The undo for this action FAILED — the world was NOT restored.{" "}
              {action.resultSummary}
            </div>
          )}
          {detail ? (
            <DiffView detail={detail} />
          ) : (
            <div className="kv">loading…</div>
          )}
          <div className="diff-title">journaled arguments (redacted)</div>
          <pre
            className="diff"
            style={{ padding: "8px 12px", margin: 0, maxHeight: 160 }}
          >
            {JSON.stringify(action.argsRedacted, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
