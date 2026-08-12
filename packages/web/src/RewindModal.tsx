import { useEffect, useState } from "react";
import { api } from "./api";
import type { ActionRecord, RewindReport } from "./types";

/**
 * Rewind flow: preview (exactly what will be undone, in order) → confirm →
 * per-action outcome report. The report never rounds up: a single failure
 * is front and center.
 */
export function RewindModal({
  anchor,
  anchorLabel,
  onClose,
}: {
  anchor: string;
  anchorLabel: string;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<ActionRecord[] | null>(null);
  const [report, setReport] = useState<RewindReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .rewindPreview(anchor)
      .then((p) => setPreview(p.actions))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [anchor]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      // Rewind exactly the previewed set: actions that executed between
      // preview and confirm must not be silently swept in.
      const { report } = await api.rewind(anchor, preview?.map((a) => a.id));
      setReport(report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={report ? onClose : undefined}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {!report ? (
          <>
            <h2>⏪ Rewind</h2>
            <div className="sub">
              Undo everything executed after <strong>{anchorLabel}</strong>, newest
              first. Reads are untouched.
            </div>
            {error && <div className="stop-banner">{error}</div>}
            {!preview ? (
              <div className="kv">computing preview…</div>
            ) : preview.length === 0 ? (
              <div className="empty">Nothing to rewind after this point.</div>
            ) : (
              <>
                <div className="diff-title">
                  {preview.length} action{preview.length === 1 ? "" : "s"} will be
                  undone in this order
                </div>
                <div className="preview-list">
                  {preview.map((a, i) => (
                    <div className="preview-item" key={a.id}>
                      <span className="t">{i + 1}.</span>
                      <span className={`badge ${a.class}`}>{a.class}</span>
                      <span style={{ flex: 1 }}>
                        {(a.resultSummary ?? a.tool).replace(/ — HELD:.*$/, "")}
                      </span>
                      <span className="blast">⌀ {a.blastRadius}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className="modal-actions">
              <button className="btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={run}
                disabled={running || !preview || preview.length === 0}
              >
                {running
                  ? "Rewinding…"
                  : `Rewind ${preview?.length ?? 0} action${preview?.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Rewind report</h2>
            <div
              className={`report-verdict ${report.fullyRestored ? "ok" : "bad"}`}
            >
              {report.fullyRestored
                ? "✓ Fully restored — every action was undone."
                : "⚠ NOT fully restored — review the outcomes below. Failures are listed exactly as they happened."}
            </div>
            <div>
              {report.outcomes.map((o) => (
                <div className="report-item" key={o.actionId}>
                  <span className={`outcome ${o.outcome}`}>{o.outcome}</span>
                  <span style={{ flex: 1 }}>
                    <div>{o.summary.replace(/ — HELD:.*$/, "")}</div>
                    <div className="detail">{o.detail}</div>
                  </span>
                </div>
              ))}
              {report.outcomes.length === 0 && (
                <div className="empty">Nothing needed rewinding.</div>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
