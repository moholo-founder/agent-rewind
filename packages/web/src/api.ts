import type {
  ActionDetail,
  ActionRecord,
  RewindReport,
  TimelineSnapshot,
} from "./types";

async function json<T>(res: Response): Promise<T> {
  // Read as text first: a non-JSON error body (proxy page, stack trace)
  // must surface as the HTTP failure it is, not a JSON parse error.
  const text = await res.text();
  let body: (T & { error?: string }) | null = null;
  try {
    body = JSON.parse(text) as T & { error?: string };
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    throw new Error(body?.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (body === null) throw new Error(`Expected JSON, got: ${text.slice(0, 200)}`);
  return body;
}

export const api = {
  timeline: () => fetch("/api/timeline").then((r) => json<TimelineSnapshot>(r)),
  actionDetail: (id: string) =>
    fetch(`/api/actions/${id}`).then((r) => json<ActionDetail>(r)),
  undo: (id: string) =>
    fetch(`/api/undo/${id}`, { method: "POST" }).then((r) =>
      json<{ result: { outcome: string; detail: string } }>(r),
    ),
  rewindPreview: (to: string) =>
    fetch(`/api/rewind/preview?to=${encodeURIComponent(to)}`).then((r) =>
      json<{ actions: ActionRecord[] }>(r),
    ),
  rewind: (toTimestamp: string, actionIds?: string[]) =>
    fetch("/api/rewind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toTimestamp, ...(actionIds ? { actionIds } : {}) }),
    }).then((r) => json<{ report: RewindReport }>(r)),
  stop: () => fetch("/api/stop", { method: "POST" }).then((r) => json(r)),
  resume: () => fetch("/api/resume", { method: "POST" }).then((r) => json(r)),
  approve: (id: string) =>
    fetch(`/api/hold/${id}/approve`, { method: "POST" }).then((r) =>
      json<{ action: ActionRecord }>(r),
    ),
  reject: (id: string) =>
    fetch(`/api/hold/${id}/reject`, { method: "POST" }).then((r) =>
      json<{ action: ActionRecord }>(r),
    ),
};
