import type { CapabilityManifest, Compensator } from "@agentrewind/core";

/**
 * Real-SMTP connector: manifest for the outbound email server.
 *
 * holdThreshold defaults to 0 — EVERY send is held for human approval.
 * Unlike the mock email's outbox recall, a real SMTP send is gone the
 * moment it executes: the compensator preserves the exact draft as a
 * snapshot and reports the undo honestly as not-reversible.
 */

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`Missing string arg "${key}"`);
  return v;
}

interface SendPreState {
  kind: "smtp-send";
  to: string;
  subject: string;
  /** Full draft, archived so an operator can see exactly what went out. */
  body: string;
  capturedAt: string;
}

export function createSmtpConnector(options: { holdThreshold?: number } = {}): {
  manifest: CapabilityManifest;
} {
  const sendCompensator: Compensator = {
    async capture(args, ctx) {
      const pre: SendPreState = {
        kind: "smtp-send",
        to: str(args, "to"),
        subject: str(args, "subject"),
        body: str(args, "body"),
        capturedAt: new Date().toISOString(),
      };
      return ctx.snapshots.putRecord(pre, { connector: "smtp", tool: "send_email" });
    },
    async undo(entry, ctx) {
      const pre = entry.preStateRef
        ? ctx.snapshots.getRecord<SendPreState>(entry.preStateRef)
        : null;
      const ident = pre ? `"${pre.subject}" to ${pre.to}` : "this email";
      return {
        outcome: "not-reversible",
        detail: `A delivered SMTP email cannot be recalled — ${ident} left the server at execution time. The exact draft is preserved in the snapshot; send a correction follow-up if needed.`,
      };
    },
  };

  const manifest: CapabilityManifest = {
    connector: "smtp",
    holdThreshold: options.holdThreshold ?? 0,
    tools: {
      send_email: {
        class: "destructive",
        compensator: sendCompensator,
        blastRadius: () => 1,
        summarize: (a) => `Send email "${a.subject as string}" to ${a.to as string}`,
      },
    },
  };

  return { manifest };
}
