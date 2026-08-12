import type {
  ActionDetail,
  ActionRecord,
  RewindReport,
  TimelineSnapshot,
} from "./types";

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
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
  rewind: (toTimestamp: string) =>
    fetch("/api/rewind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toTimestamp }),
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
