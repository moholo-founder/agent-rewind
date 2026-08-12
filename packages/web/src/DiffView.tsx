import { diffLines } from "./diff";
import type { ActionDetail } from "./types";

/**
 * Before/after rendering per pre-state kind. The rule everywhere: show what
 * existed before, what the action did to it, and what an undo would bring
 * back — with no pretending.
 */
export function DiffView({ detail }: { detail: ActionDetail }) {
  const { action, preState } = detail;
  if (!preState) {
    return (
      <div className="kv">
        No pre-state was captured for this action
        {action.class === "read" ? " (reads are never snapshotted)." : "."}
      </div>
    );
  }

  switch (preState.kind) {
    case "file": {
      const before = preState.present ? String(preState.content ?? "") : "";
      if (action.tool === "write_file") {
        const after = String(
          (action.argsRedacted as { content?: unknown })?.content ?? "",
        );
        return (
          <>
            <div className="diff-title">
              {preState.present ? "content diff (before → after)" : "new file content"}
            </div>
            <div className="diff">
              {diffLines(before, after).map((l, i) => (
                <div key={i} className={`line ${l.kind}`}>
                  {l.text}
                </div>
              ))}
            </div>
          </>
        );
      }
      return (
        <>
          <div className="diff-title">content before deletion (what undo restores)</div>
          <div className="diff">
            {before.split("\n").map((text, i) => (
              <div key={i} className="line removed">
                {text}
              </div>
            ))}
          </div>
        </>
      );
    }

    case "tree": {
      const entries = (preState.entries ?? []) as { rel: string; type: string }[];
      const files = entries.filter((e) => e.type === "file");
      return (
        <>
          <div className="diff-title">
            directory snapshot — {String(preState.fileCount)} files captured (what undo
            restores)
          </div>
          <div className="file-list">
            {files.slice(0, 400).map((f) => (
              <div key={f.rel}>{f.rel}</div>
            ))}
            {files.length > 400 && (
              <div className="more-note">…and {files.length - 400} more</div>
            )}
          </div>
        </>
      );
    }

    case "email-folder": {
      const messages = (preState.messages ?? []) as {
        id: string;
        from: string;
        subject: string;
        ts: string;
      }[];
      const count = Number(preState.count ?? messages.length);
      return (
        <>
          <div className="diff-title">
            {count} messages were in “{String(preState.folder)}” (what undo restores)
          </div>
          <div className="diff" style={{ maxHeight: 280 }}>
            <table className="msg-table">
              <thead>
                <tr>
                  <th>from</th>
                  <th>subject</th>
                  <th>received</th>
                </tr>
              </thead>
              <tbody>
                {messages.slice(0, 12).map((m) => (
                  <tr key={m.id}>
                    <td>{m.from}</td>
                    <td>{m.subject}</td>
                    <td className="t">{new Date(m.ts).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {count > 12 && <div className="more-note">…and {count - 12} more</div>}
          </div>
        </>
      );
    }

    case "email-message": {
      const msg = preState.message as {
        from: string;
        to: string;
        subject: string;
        body: string;
        folder: string;
      };
      return (
        <>
          <div className="diff-title">
            message was in “{msg.folder}” (undo moves it back)
          </div>
          <div className="diff" style={{ padding: "10px 12px" }}>
            <div className="line same">From: {msg.from}</div>
            <div className="line same">To: {msg.to}</div>
            <div className="line same">Subject: {msg.subject}</div>
            <div className="line same"> </div>
            {msg.body.split("\n").map((t, i) => (
              <div key={i} className="line same">
                {t}
              </div>
            ))}
          </div>
        </>
      );
    }

    case "email-send":
      return (
        <div className="kv">
          Outbound message to <strong>{String(preState.to)}</strong> (“
          {String(preState.subject)}”). Undo recalls it from the outbox — only
          possible while the delivery window is open; afterwards it is honestly
          not reversible.
        </div>
      );

    case "move":
      return (
        <div className="kv">
          {String(preState.src)} → {String(preState.dest)}
          {preState.destExisted
            ? " (destination existed and was snapshotted; undo restores both)"
            : " (undo moves it back)"}
        </div>
      );

    case "unavailable":
      return (
        <div className="kv" style={{ color: "var(--danger)" }}>
          Pre-state snapshot unavailable: {String(preState.error)}
        </div>
      );

    default:
      return <pre className="kv">{JSON.stringify(preState, null, 2)}</pre>;
  }
}
