import express, { type Express, type Request, type Response } from "express";
import path from "node:path";
import type { AgentRewindRuntime } from "@agentrewind/proxy";
import type { ActionRecord, TimelineEvent } from "@agentrewind/core";

/**
 * Thin HTTP shell over AgentRewindRuntime for the timeline UI.
 *
 * REST for commands and history, Server-Sent Events for liveness. No auth
 * (explicit v1 non-goal) — bind to localhost.
 */

const MAX_INLINE_CONTENT = 200_000; // chars of file content shipped to the UI

interface PreStateView {
  kind: string;
  [key: string]: unknown;
}

export function createApiServer(
  runtime: AgentRewindRuntime,
  options: { staticDir?: string } = {},
): Express {
  const app = express();
  app.use(express.json());

  // ---- state & timeline ----------------------------------------------------

  app.get("/api/state", (_req, res) => {
    res.json({
      stopped: runtime.isStopped(),
      held: runtime.journal.listHeld().length,
    });
  });

  app.get("/api/timeline", (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 500;
    res.json({
      stopped: runtime.isStopped(),
      actions: runtime.journal.list({ limit }),
      held: runtime.journal.listHeld(),
      rewinds: runtime.journal.listRewinds(),
    });
  });

  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
    const onEvent = (event: TimelineEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    runtime.events.on("timeline", onEvent);
    const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      runtime.events.off("timeline", onEvent);
    });
  });

  // ---- action detail (diff payload) -----------------------------------------

  app.get("/api/actions/:id", (req, res) => {
    let action: ActionRecord;
    try {
      action = runtime.journal.get(req.params.id);
    } catch {
      res.status(404).json({ error: "No such action" });
      return;
    }
    let preState: PreStateView | null = null;
    if (action.preStateRef) {
      try {
        preState = resolvePreState(runtime, action.preStateRef);
      } catch (err) {
        preState = {
          kind: "unavailable",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    res.json({ action, preState });
  });

  // ---- commands --------------------------------------------------------------

  app.post("/api/undo/:id", async (req, res) => {
    try {
      const result = await runtime.undoAction(req.params.id);
      res.json({ result });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/rewind/preview", (req, res) => {
    const to = String(req.query.to ?? "");
    if (!to) {
      res.status(400).json({ error: "Missing ?to=<ISO timestamp>" });
      return;
    }
    res.json({ actions: runtime.journal.listRewindable(to) });
  });

  app.post("/api/rewind", async (req, res) => {
    const to = (req.body as { toTimestamp?: string }).toTimestamp;
    if (!to) {
      res.status(400).json({ error: "Body must include toTimestamp (ISO)" });
      return;
    }
    const report = await runtime.rewind(to);
    res.json({ report });
  });

  app.post("/api/stop", (_req, res) => {
    runtime.stop();
    res.json({ stopped: true });
  });

  app.post("/api/resume", (_req, res) => {
    runtime.resume();
    res.json({ stopped: false });
  });

  app.post("/api/hold/:id/approve", async (req, res) => {
    try {
      const outcome = await runtime.approveHeld(req.params.id);
      res.json({ action: outcome.action });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/hold/:id/reject", (req, res) => {
    try {
      res.json({ action: runtime.rejectHeld(req.params.id) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- static UI (production demo mode) --------------------------------------

  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.get("{*splat}", (req: Request, res: Response) => {
      if (req.path.startsWith("/api/")) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.sendFile(path.join(options.staticDir!, "index.html"));
    });
  }

  return app;
}

/**
 * Resolve a pre-state snapshot into something the UI can render as the
 * "before" side of a diff. File contents are inlined (capped); trees ship
 * their manifest without contents.
 */
function resolvePreState(runtime: AgentRewindRuntime, ref: string): PreStateView {
  const record = runtime.snapshots.getRecord<PreStateView>(ref);
  if (record.kind === "file" && record.present && typeof record.contentRef === "string") {
    const blob = runtime.snapshots.getBlob(record.contentRef);
    const text = blob.toString("utf8");
    return {
      ...record,
      content: text.slice(0, MAX_INLINE_CONTENT),
      truncated: text.length > MAX_INLINE_CONTENT,
    };
  }
  if (record.kind === "email-folder" && Array.isArray(record.messages)) {
    return {
      ...record,
      count: (record.messages as unknown[]).length,
      messages: (record.messages as { id: string; from: string; subject: string; ts: string; folder: string }[])
        .slice(0, 500)
        .map((m) => ({ id: m.id, from: m.from, subject: m.subject, ts: m.ts, folder: m.folder })),
    };
  }
  return record;
}
