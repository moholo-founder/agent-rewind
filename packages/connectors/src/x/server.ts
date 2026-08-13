import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { oauth1Header, type OAuth1Credentials } from "./oauth1.js";
import { PostLog } from "./postlog.js";

/**
 * REAL outbound X (Twitter) MCP server — posts through the official API v2
 * with OAuth 1.0a user context. Credentials arrive via constructor options
 * (the CLI reads them from env in the child process); they never appear in
 * tool arguments, so they can never reach the journal.
 *
 * `admin__` tools are the compensator surface: the proxy hides them from the
 * agent and refuses direct calls (no route is registered for them).
 */

export interface XServerOptions {
  credentials: OAuth1Credentials;
  /** API origin, overridable for tests. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** JSONL posted-tweet log; omit for in-memory (tests). */
  logPath?: string;
}

async function apiError(res: Response): Promise<Error> {
  const body = (await res.text().catch(() => "")).slice(0, 300);
  return new Error(`X API ${res.status}: ${body || res.statusText}`);
}

export function createXMcpServer(options: XServerOptions): {
  server: McpServer;
  log: PostLog;
} {
  const base = (options.baseUrl ?? "https://api.x.com").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const log = new PostLog(options.logPath);
  const server = new McpServer({ name: "agent-rewind-x", version: "0.1.0" });

  const ok = (payload: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  });
  const auth = (method: string, url: string) =>
    oauth1Header({ method, url, credentials: options.credentials });

  server.registerTool(
    "post_tweet",
    {
      description:
        "Publish a post on X (Twitter). Public and immediate once approved.",
      inputSchema: { text: z.string().min(1).max(25_000) },
    },
    async ({ text }) => {
      const url = `${base}/2/tweets`;
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: auth("POST", url),
          "content-type": "application/json",
        },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw await apiError(res);
      const { data } = (await res.json()) as { data: { id: string } };
      log.record({ id: data.id, text, ts: new Date().toISOString() });
      return ok({ id: data.id, url: `https://x.com/i/status/${data.id}` });
    },
  );

  server.registerTool(
    "admin__delete_tweet",
    {
      description:
        "ADMIN: delete the tweet matching (text, capture window) — undo of post_tweet.",
      inputSchema: { text: z.string(), after: z.string().optional() },
    },
    async ({ text, after }) => {
      const entry = log.find(text, after);
      if (!entry) {
        return ok({
          deleted: false,
          reason: "No matching tweet in the post log for this text/window",
        });
      }
      const url = `${base}/2/tweets/${entry.id}`;
      const res = await doFetch(url, {
        method: "DELETE",
        headers: { authorization: auth("DELETE", url) },
      });
      if (res.status === 404) {
        // The tweet is gone either way; the world matches the undo's goal.
        log.markDeleted(entry.id);
        return ok({
          deleted: true,
          id: entry.id,
          reason: `Tweet ${entry.id} was already gone (404)`,
        });
      }
      if (!res.ok) {
        return ok({ deleted: false, reason: (await apiError(res)).message });
      }
      const body = (await res.json()) as { data?: { deleted?: boolean } };
      if (body.data?.deleted) {
        log.markDeleted(entry.id);
        return ok({ deleted: true, id: entry.id, reason: `Deleted tweet ${entry.id}` });
      }
      return ok({ deleted: false, reason: "X API reported deleted=false" });
    },
  );

  return { server, log };
}
