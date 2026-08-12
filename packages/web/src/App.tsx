import { useState } from "react";
import { ActionRow } from "./ActionRow";
import { api } from "./api";
import { RewindModal } from "./RewindModal";
import type { ActionRecord } from "./types";
import { useAgentRewind } from "./useAgentRewind";
import "./styles.css";

export function App() {
  const { connected, stopped, actions, held, refresh } = useAgentRewind();
  const [rewindAnchor, setRewindAnchor] = useState<{ iso: string; label: string } | null>(null);
  const [heldError, setHeldError] = useState<string | null>(null);

  const rewindToBefore = (a: ActionRecord) => {
    const t = new Date(a.executedTs ?? a.ts).getTime() - 1;
    setRewindAnchor({
      iso: new Date(t).toISOString(),
      label: `“${(a.resultSummary ?? a.tool).replace(/ — HELD:.*$/, "")}” (${new Date(t).toLocaleTimeString()})`,
    });
  };

  const rewindEverything = () => {
    // Anchor on the earliest EXECUTION time, not journal order: a held
    // action approved late executes out of ts order and would otherwise be
    // left out of "rewind everything".
    const executedTimes = actions
      .filter((a) => a.executedTs && a.causedBy === null && a.class !== "read")
      .map((a) => new Date(a.executedTs!).getTime());
    if (executedTimes.length === 0) return;
    const t = Math.min(...executedTimes) - 1;
    setRewindAnchor({
      iso: new Date(t).toISOString(),
      label: `the beginning of the session (${new Date(t).toLocaleTimeString()})`,
    });
  };

  const decide = async (id: string, verb: "approve" | "reject") => {
    setHeldError(null);
    try {
      await (verb === "approve" ? api.approve(id) : api.reject(id));
    } catch (err) {
      setHeldError(
        `${verb === "approve" ? "Approve" : "Reject"} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      refresh();
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <h1>AGENT REWIND</h1>
          <span className="tag">flight recorder for AI agents</span>
        </div>
        <span className={`conn ${connected ? "live" : "dead"}`}>
          {connected ? "live" : "disconnected"}
        </span>
        <div className="spacer" />
        <button className="rewind-here-btn" onClick={rewindEverything}>
          ⏪ Rewind…
        </button>
        <div className="stop-switch">
          <span className="label">{stopped ? "TRIPPED" : "ARMED"}</span>
          {stopped ? (
            <button className="resume-btn" onClick={() => api.resume()}>
              RESUME
            </button>
          ) : null}
          <button
            className={`stop-btn${stopped ? " tripped" : ""}`}
            onClick={() => (stopped ? undefined : api.stop())}
          >
            STOP
          </button>
        </div>
      </header>

      {stopped && (
        <div className="stop-banner">
          ⛔ Kill switch engaged — every side-effecting action is refused and
          journaled as blocked. Reads still pass. Only RESUME clears this; the
          agent cannot.
        </div>
      )}

      {held.length > 0 && (
        <section className="held-tray">
          <h2>⏸ HELD — WAITING FOR YOUR DECISION ({held.length})</h2>
          {heldError && (
            <div className="stop-banner" style={{ margin: "10px 16px" }}>
              ⚠ {heldError}
            </div>
          )}
          {held.map((a) => (
            <div className="held-item" key={a.id}>
              <span className={`badge ${a.class}`}>{a.class}</span>
              <div className="what">
                <div className="summary">
                  {(a.resultSummary ?? a.tool).replace(/ — HELD:.*$/, "")}
                </div>
                <div className="reason">
                  {/ — HELD: (.*)$/.exec(a.resultSummary ?? "")?.[1] ??
                    "Held for approval"}
                  {" · "}blast radius {a.blastRadius}
                </div>
              </div>
              <button className="approve-btn" onClick={() => decide(a.id, "approve")}>
                Approve
              </button>
              <button className="reject-btn" onClick={() => decide(a.id, "reject")}>
                Reject
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="timeline">
        <div className="timeline-head">
          <h2>ACTION TIMELINE</h2>
          <span className="count">
            {actions.length} recorded · newest first · every side-effecting action
            is snapshotted before it runs
          </span>
        </div>
        {actions.length === 0 ? (
          <div className="empty">
            No actions yet — Agent Rewind is listening. Point an agent at the proxy
            and everything it does will appear here.
          </div>
        ) : (
          actions.map((a) => (
            <ActionRow key={a.id} action={a} onRewindHere={rewindToBefore} />
          ))
        )}
      </section>

      {rewindAnchor && (
        <RewindModal
          anchor={rewindAnchor.iso}
          anchorLabel={rewindAnchor.label}
          onClose={() => {
            setRewindAnchor(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
