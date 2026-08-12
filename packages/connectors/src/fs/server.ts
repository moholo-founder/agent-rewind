import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as ops from "./ops.js";
import { Sandbox } from "./sandbox.js";

/**
 * Downstream filesystem MCP server. This is the "real tool" the agent
 * thinks it is talking to; Backstop proxies in front of it. It enforces the
 * sandbox itself as well — defense in depth, in case anyone ever wires an
 * agent to it directly.
 */
export function createFilesystemMcpServer(root: string): McpServer {
  const sandbox = new Sandbox(root);
  const server = new McpServer({ name: "backstop-fs", version: "0.1.0" });

  const ok = (payload: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
    ],
  });

  server.registerTool(
    "read_file",
    {
      description: "Read a UTF-8 file. Path is relative to the sandbox root.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => ok(ops.readFile(sandbox, path)),
  );

  server.registerTool(
    "list_dir",
    {
      description: "List a directory. Path is relative to the sandbox root ('.' for root).",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => ok(ops.listDir(sandbox, path)),
  );

  server.registerTool(
    "write_file",
    {
      description: "Create or overwrite a UTF-8 file.",
      inputSchema: { path: z.string(), content: z.string() },
    },
    async ({ path, content }) => {
      ops.writeFile(sandbox, path, content);
      return ok({ written: path });
    },
  );

  server.registerTool(
    "move",
    {
      description: "Move/rename a file or directory.",
      inputSchema: { src: z.string(), dest: z.string() },
    },
    async ({ src, dest }) => {
      ops.move(sandbox, src, dest);
      return ok({ moved: src, to: dest });
    },
  );

  server.registerTool(
    "delete_file",
    {
      description: "Delete a single file.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      ops.deleteFile(sandbox, path);
      return ok({ deleted: path });
    },
  );

  server.registerTool(
    "delete_dir",
    {
      description: "Recursively delete a directory.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      const count = ops.countFiles(sandbox, path);
      ops.deleteDir(sandbox, path);
      return ok({ deleted: path, files: count });
    },
  );

  return server;
}
