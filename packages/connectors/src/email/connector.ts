import type {
  CapabilityManifest,
  Compensator,
  CompensatorContext,
  UndoResult,
} from "@backstop/core";
import type { EmailMessage } from "./store.js";

/**
 * Mock-email connector: capability manifest + compensators.
 *
 * Unlike the filesystem connector, these compensators never touch the
 * store directly — they act purely through the downstream server's
 * admin__ tools, so they work identically whether the email server runs
 * in-process or as a separate stdio child.
 */

function firstTextJson<T>(result: unknown): T {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  const text = content?.find((c) => c.type === "text")?.text;
  if (text === undefined) throw new Error("Downstream returned no text content");
  return JSON.parse(text) as T;
}

async function call<T>(
  ctx: CompensatorContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<T> {
  return firstTextJson<T>(await ctx.callDownstream(tool, args));
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`Missing string arg "${key}"`);
  return v;
}

interface MessagePreState {
  kind: "email-message";
  message: EmailMessage;
}

interface FolderPreState {
  kind: "email-folder";
  folder: string;
  messages: EmailMessage[];
}

interface SendPreState {
  kind: "email-send";
  to: string;
  subject: string;
}

export function createEmailConnector(options: { holdThreshold?: number } = {}): {
  manifest: CapabilityManifest;
} {
  const deleteMessageCompensator: Compensator = {
    async capture(args, ctx) {
      const message = await call<EmailMessage>(ctx, "read_message", { id: str(args, "id") });
      const pre: MessagePreState = { kind: "email-message", message };
      return ctx.snapshots.putRecord(pre, { connector: "email", tool: "delete_message" });
    },
    async undo(entry, ctx) {
      if (!entry.preStateRef) {
        return { outcome: "failed", detail: "No captured pre-state for this delete" };
      }
      const pre = ctx.snapshots.getRecord<MessagePreState>(entry.preStateRef);
      await call(ctx, "admin__restore_message", {
        id: pre.message.id,
        folder: pre.message.folder,
      });
      return {
        outcome: "undone",
        detail: `Restored "${pre.message.subject}" to ${pre.message.folder}`,
      };
    },
  };

  const deleteManyCompensator: Compensator = {
    async capture(args, ctx) {
      const folder = str(args, "folder");
      const messages = await call<EmailMessage[]>(ctx, "admin__dump_folder", { folder });
      const pre: FolderPreState = { kind: "email-folder", folder, messages };
      return ctx.snapshots.putRecord(pre, {
        connector: "email",
        tool: "delete_many",
        count: messages.length,
      });
    },
    async undo(entry, ctx) {
      if (!entry.preStateRef) {
        return { outcome: "failed", detail: "No captured pre-state for this bulk delete" };
      }
      const pre = ctx.snapshots.getRecord<FolderPreState>(entry.preStateRef);
      let restored = 0;
      const failures: string[] = [];
      for (const msg of pre.messages) {
        try {
          await call(ctx, "admin__restore_message", { id: msg.id, folder: pre.folder });
          restored += 1;
        } catch (err) {
          failures.push(`${msg.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failures.length === 0) {
        return {
          outcome: "undone",
          detail: `Restored ${restored} messages to ${pre.folder}`,
        };
      }
      return {
        outcome: restored > 0 ? "partial" : "failed",
        detail: `Restored ${restored}/${pre.messages.length} messages to ${pre.folder}; failures: ${failures.slice(0, 3).join("; ")}`,
      } satisfies UndoResult;
    },
  };

  const sendCompensator: Compensator = {
    async capture(args, ctx) {
      // Nothing is destroyed by a send; we record the identity we'll need
      // to recall it from the outbox within the delivery window.
      const pre: SendPreState = {
        kind: "email-send",
        to: str(args, "to"),
        subject: str(args, "subject"),
      };
      return ctx.snapshots.putRecord(pre, { connector: "email", tool: "send_message" });
    },
    async undo(entry, ctx) {
      if (!entry.preStateRef) {
        return { outcome: "failed", detail: "No captured send identity" };
      }
      const pre = ctx.snapshots.getRecord<SendPreState>(entry.preStateRef);
      const result = await call<{ canceled: boolean; reason: string }>(
        ctx,
        "admin__cancel_send",
        { to: pre.to, subject: pre.subject },
      );
      if (result.canceled) {
        return { outcome: "undone", detail: result.reason };
      }
      // Time-bounded reversibility, reported honestly: after the delivery
      // window this send is simply not reversible.
      return { outcome: "not-reversible", detail: result.reason };
    },
  };

  const moveCompensator: Compensator = {
    async capture(args, ctx) {
      const message = await call<EmailMessage>(ctx, "read_message", { id: str(args, "id") });
      const pre: MessagePreState = { kind: "email-message", message };
      return ctx.snapshots.putRecord(pre, { connector: "email", tool: "move_message" });
    },
    async undo(entry, ctx) {
      if (!entry.preStateRef) {
        return { outcome: "failed", detail: "No captured pre-state for this move" };
      }
      const pre = ctx.snapshots.getRecord<MessagePreState>(entry.preStateRef);
      await call(ctx, "admin__restore_message", {
        id: pre.message.id,
        folder: pre.message.folder,
      });
      return {
        outcome: "undone",
        detail: `Moved "${pre.message.subject}" back to ${pre.message.folder}`,
      };
    },
  };

  const manifest: CapabilityManifest = {
    connector: "email",
    holdThreshold: options.holdThreshold ?? 50,
    adminToolPrefix: "admin__",
    tools: {
      list_messages: {
        class: "read",
        summarize: (a) => `Listed ${a.folder as string} messages`,
      },
      read_message: {
        class: "read",
        summarize: (a) => `Read message ${a.id as string}`,
      },
      send_message: {
        class: "reversible",
        compensator: sendCompensator,
        blastRadius: () => 1,
        summarize: (a) => `Sent "${a.subject as string}" to ${a.to as string}`,
      },
      move_message: {
        class: "reversible",
        compensator: moveCompensator,
        blastRadius: () => 1,
        summarize: (a) => `Moved message ${a.id as string} to ${a.folder as string}`,
      },
      delete_message: {
        class: "destructive",
        compensator: deleteMessageCompensator,
        blastRadius: () => 1,
        summarize: (a) => `Deleted message ${a.id as string}`,
      },
      delete_many: {
        class: "destructive",
        compensator: deleteManyCompensator,
        blastRadius: async (a, ctx) =>
          (await call<{ count: number }>(ctx, "admin__count", { folder: a.folder }))
            .count,
        summarize: (a) => `Deleted all messages in ${a.folder as string}`,
      },
    },
  };

  return { manifest };
}
