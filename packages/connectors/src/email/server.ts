import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EmailStore, type EmailFolder } from "./store.js";

/**
 * Self-contained mock email MCP server.
 *
 * Tools prefixed `admin__` exist for Agent Rewind's compensators only: the
 * proxy hides them from the agent's tool list and the agent can never call
 * them (the proxy routes by the listed tools, and even a direct call would
 * be journaled as unknown/held). They are the restore/recall surface.
 */

const FOLDER = z.enum(["inbox", "sent", "outbox", "__trash", "__recalled"]);

export interface EmailServerOptions {
  /** How long a sent message sits in the outbox before delivery. */
  deliveryWindowMs?: number;
  /** The mock account's own address. */
  selfAddress?: string;
}

export function createEmailMcpServer(
  dbPath: string,
  options: EmailServerOptions = {},
): { server: McpServer; store: EmailStore } {
  const deliveryWindowMs = options.deliveryWindowMs ?? 60_000;
  const selfAddress = options.selfAddress ?? "agent@agent-rewind.local";
  const store = new EmailStore(dbPath);
  const server = new McpServer({ name: "agent-rewind-mock-email", version: "0.1.0" });

  const ok = (payload: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  });

  // ---- agent-visible tools ----

  server.registerTool(
    "list_messages",
    {
      description: "List messages in a folder (inbox, sent, outbox, __trash).",
      inputSchema: { folder: FOLDER, limit: z.number().int().positive().optional() },
    },
    async ({ folder, limit }) =>
      ok(
        store.list(folder as EmailFolder, limit ?? 500).map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          subject: m.subject,
          ts: m.ts,
        })),
      ),
  );

  server.registerTool(
    "read_message",
    {
      description: "Read a full message by id.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const msg = store.get(id);
      if (!msg) throw new Error(`No message with id ${id}`);
      return ok(msg);
    },
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send an email. The message is queued in the outbox and delivered after a short window.",
      inputSchema: { to: z.string(), subject: z.string(), body: z.string() },
    },
    async ({ to, subject, body }) => {
      const msg = store.send({ from: selfAddress, to, subject, body, deliveryWindowMs });
      return ok({ queued: msg.id, deliverAfter: msg.deliverAfter });
    },
  );

  server.registerTool(
    "move_message",
    {
      description: "Move a message to another folder.",
      inputSchema: { id: z.string(), folder: FOLDER },
    },
    async ({ id, folder }) => ok(store.moveTo(id, folder as EmailFolder)),
  );

  server.registerTool(
    "delete_message",
    {
      description: "Delete a message (moves to trash).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => ok(store.moveTo(id, "__trash")),
  );

  server.registerTool(
    "delete_many",
    {
      description: "Delete every message in a folder (moves them to trash).",
      inputSchema: { folder: FOLDER },
    },
    async ({ folder }) => {
      const ids = store.trashFolder(folder as EmailFolder);
      return ok({ deleted: ids.length, folder });
    },
  );

  // ---- admin (compensator-only) tools ----

  server.registerTool(
    "admin__restore_message",
    {
      description: "ADMIN: move a message back to a folder (undo surface).",
      inputSchema: { id: z.string(), folder: FOLDER },
    },
    async ({ id, folder }) => ok(store.moveTo(id, folder as EmailFolder)),
  );

  server.registerTool(
    "admin__dump_folder",
    {
      description: "ADMIN: full message records for a folder (capture surface).",
      inputSchema: { folder: FOLDER },
    },
    async ({ folder }) => ok(store.list(folder as EmailFolder, 100_000)),
  );

  server.registerTool(
    "admin__cancel_send",
    {
      description: "ADMIN: recall a queued outbox message (undo of send).",
      inputSchema: {
        to: z.string(),
        subject: z.string(),
        after: z.string().optional(),
      },
    },
    async ({ to, subject, after }) =>
      ok(store.cancelSend({ to, subject, ...(after !== undefined ? { after } : {}) })),
  );

  server.registerTool(
    "admin__count",
    {
      description: "ADMIN: count messages in a folder (blast-radius surface).",
      inputSchema: { folder: FOLDER },
    },
    async ({ folder }) => ok({ count: store.count(folder as EmailFolder) }),
  );

  server.registerTool(
    "admin__deliver_due",
    {
      description: "ADMIN: deliver outbox messages whose window elapsed.",
      inputSchema: {},
    },
    async () => ok({ delivered: store.deliverDue() }),
  );

  return { server, store };
}
