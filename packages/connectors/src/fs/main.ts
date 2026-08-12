#!/usr/bin/env node
/**
 * Stdio entry point for the downstream filesystem MCP server.
 * Usage: node dist/fs/main.js <sandbox-root>
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFilesystemMcpServer } from "./server.js";

const root = process.argv[2];
if (!root) {
  console.error("Usage: fs-mcp-server <sandbox-root>");
  process.exit(1);
}

const server = createFilesystemMcpServer(root);
await server.connect(new StdioServerTransport());
