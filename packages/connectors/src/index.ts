/**
 * @agentrewind/connectors — capability manifests & compensators.
 */
export { Sandbox, SandboxViolation } from "./fs/sandbox.js";
export * as fsOps from "./fs/ops.js";
export {
  createFilesystemConnector,
  type FilesystemConnector,
} from "./fs/connector.js";
export { createFilesystemMcpServer } from "./fs/server.js";
export { EmailStore, type EmailMessage, type EmailFolder } from "./email/store.js";
export { createEmailMcpServer, type EmailServerOptions } from "./email/server.js";
export { createEmailConnector } from "./email/connector.js";
export { seedInbox } from "./email/seed.js";
