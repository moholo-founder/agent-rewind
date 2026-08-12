/**
 * @backstop/connectors — capability manifests & compensators.
 */
export { Sandbox, SandboxViolation } from "./fs/sandbox.js";
export * as fsOps from "./fs/ops.js";
export {
  createFilesystemConnector,
  type FilesystemConnector,
} from "./fs/connector.js";
export { createFilesystemMcpServer } from "./fs/server.js";
