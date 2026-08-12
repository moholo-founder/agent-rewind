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
    // Clamp untrusted input: a non-numeric limit must not reach SQL, and a
    // negative one must not disable the row cap.
    const raw = Number(req.query.limit);
    const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 10_000) : 500;
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
    const to = parseIsoTimestamp(req.query.to);
    if (!to) {
      res.status(400).json({ error: "?to must be an ISO-8601 timestamp" });
      return;
    }
    res.json({ actions: runtime.journal.listRewindable(to) });
  });

  app.post("/api/rewind", async (req, res) => {
    const body = req.body as { toTimestamp?: unknown; actionIds?: unknown };
    // Strict validation: under SQLite affinity a sloppy value like the
    // number 1 compares as less-than every ISO string, silently turning a
    // bounded rewind into an undo of the entire history.
    const to = parseIsoTimestamp(body.toTimestamp);
    if (!to) {
      res.status(400).json({ error: "toTimestamp must be an ISO-8601 timestamp string" });
      return;
    }
    let actionIds: string[] | undefined;
    if (body.actionIds !== undefined) {
      if (
        !Array.isArray(body.actionIds) ||
        !body.actionIds.every((x) => typeof x === "string")
      ) {
        res.status(400).json({ error: "actionIds must be an array of strings" });
        return;
      }
      actionIds = body.actionIds as string[];
    }
    const report = await runtime.rewind(to, actionIds);
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

/** Accept only real ISO-8601 timestamp strings (see rewind validation). */
function parseIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return null;
  }
  return Number.isFinite(Date.parse(value)) ? value : null;
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
