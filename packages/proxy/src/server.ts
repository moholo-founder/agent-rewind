import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { BackstopRuntime } from "./runtime.js";

/**
 * The agent-facing MCP server: re-exposes every downstream tool (minus
 * admin-only ones) and funnels each call through the runtime's gate.
 * Deliberately a thin shell — all decisions live in BackstopRuntime.
 */
export function createProxyServer(runtime: BackstopRuntime): Server {
  const server = new Server(
    { name: "backstop-proxy", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: runtime.listToolsForAgent() as {
      name: string;
      inputSchema: { type: "object" };
    }[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const outcome = await runtime.handleToolCall(
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
    );
    return {
      content: outcome.content,
      ...(outcome.isError ? { isError: true } : {}),
    };
  });

  return server;
}
