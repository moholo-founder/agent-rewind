#!/usr/bin/env node
/**
 * Stdio entry point for the mock email MCP server.
 * Usage: node dist/email/main.js <db-path> [deliveryWindowMs]
 *
 * Seeds a 200-message inbox on first run and delivers due outbox messages
 * once per second.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { seedInbox } from "./seed.js";
import { createEmailMcpServer } from "./server.js";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("Usage: email-mcp-server <db-path> [deliveryWindowMs]");
  process.exit(1);
}
const deliveryWindowMs = process.argv[3] ? Number(process.argv[3]) : 60_000;

const { server, store } = createEmailMcpServer(dbPath, { deliveryWindowMs });
seedInbox(store);
const timer = setInterval(() => store.deliverDue(), 1000);
timer.unref();

await server.connect(new StdioServerTransport());
