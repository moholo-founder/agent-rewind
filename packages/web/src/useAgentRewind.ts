import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { ActionRecord, RewindReport, TimelineEvent } from "./types";

export interface AgentRewindState {
  connected: boolean;
  stopped: boolean;
  actions: ActionRecord[];
  /**
   * Held actions tracked from the snapshot's dedicated (uncapped) held list
   * plus live events — NOT derived from the row-capped actions array, so an
   * old held item stays approvable however long the timeline grows.
   */
  held: ActionRecord[];
  rewinds: RewindReport[];
}

function upsertHeld(held: ActionRecord[], action: ActionRecord): ActionRecord[] {
  const without = held.filter((h) => h.id !== action.id);
  return action.status === "held" ? [...without, action] : without;
}

/**
 * Live timeline state: initial fetch + SSE merge. Status events update rows
 * in place; a completed rewind — or an SSE reconnect, which may have missed
 * events — triggers a full refetch.
 */
export function useAgentRewind(): AgentRewindState & { refresh: () => void } {
  const [state, setState] = useState<AgentRewindState>({
    connected: false,
    stopped: false,
    actions: [],
    held: [],
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
          held: t.held,
          rewinds: t.rewinds,
        })),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");
    esRef.current = es;
    es.onopen = () => {
      setState((s) => ({ ...s, connected: true }));
      // Reconnect = a gap in events; resync the whole snapshot.
      refresh();
    };
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
            return { ...s, actions, held: upsertHeld(s.held, action) };
          }
          case "status": {
            const action = event.action!;
            return {
              ...s,
              actions: s.actions.map((a) => (a.id === action.id ? action : a)),
              held: upsertHeld(s.held, action),
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
