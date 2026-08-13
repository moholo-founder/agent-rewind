import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DeliverFn } from "./mailer.js";

/**
 * REAL outbound email MCP server. One tool, no admin surface: a delivered
 * email has no undo, so there is nothing for a compensator to call back
 * into — the honesty lives in the connector's not-reversible undo.
 */

export interface SmtpMcpServerOptions {
  /** The From: address stamped on every send. */
  from: string;
  deliver: DeliverFn;
}

export function createSmtpMcpServer(options: SmtpMcpServerOptions): McpServer {
  const server = new McpServer({ name: "agent-rewind-smtp", version: "0.1.0" });

  server.registerTool(
    "send_email",
    {
      description:
        "Send a REAL email via SMTP. Delivery is immediate once approved and cannot be recalled.",
      inputSchema: {
        to: z.email(),
        subject: z.string().min(1),
        body: z.string().min(1),
      },
    },
    async ({ to, subject, body }) => {
      const { messageId } = await options.deliver({
        from: options.from,
        to,
        subject,
        text: body,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              sent: true,
              to,
              subject,
              messageId: messageId ?? null,
            }),
          },
        ],
      };
    },
  );

  return server;
}
