import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { ActionRecord, RewindReport, TimelineEvent } from "./types";

export interface BackstopState {
  connected: boolean;
  stopped: boolean;
  actions: ActionRecord[];
  rewinds: RewindReport[];
}

/**
 * Live timeline state: initial fetch + SSE merge. Status events update rows
 * in place; a completed rewind triggers a refetch (bulk status change).
 */
export function useBackstop(): BackstopState & { refresh: () => void } {
  const [state, setState] = useState<BackstopState>({
    connected: false,
    stopped: false,
    actions: [],
    rewinds: [],
  });
  const esRef = useRef<EventSource | null>(null);

  const refresh = useCallback(() => {
    api
      .timeline()
      .then((t) =>
        setState((s) => ({
          ...s,
          stopped: t.stopped,
          actions: t.actions,
          rewinds: t.rewinds,
        })),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const es = new EventSource("/api/events");
    esRef.current = es;
    es.onopen = () => setState((s) => ({ ...s, connected: true }));
    es.onerror = () => setState((s) => ({ ...s, connected: false }));
    es.onmessage = (msg) => {
      const event = JSON.parse(msg.data as string) as TimelineEvent;
      setState((s) => {
        switch (event.type) {
          case "action": {
            const action = event.action!;
            const existing = s.actions.findIndex((a) => a.id === action.id);
            const actions =
              existing >= 0
                ? s.actions.map((a) => (a.id === action.id ? action : a))
                : [action, ...s.actions];
            return { ...s, actions };
          }
          case "status": {
            const action = event.action!;
            return {
              ...s,
              actions: s.actions.map((a) => (a.id === action.id ? action : a)),
            };
          }
          case "stop":
            return { ...s, stopped: event.stopped ?? false };
          case "rewind":
            return { ...s, rewinds: [event.rewind!, ...s.rewinds] };
          default:
            return s;
        }
      });
      if (event.type === "rewind") refresh();
    };
    return () => es.close();
  }, [refresh]);

  return { ...state, refresh };
}
