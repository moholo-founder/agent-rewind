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
export { seedDemoSandbox } from "./demo-seed.js";
export {
  createSmtpDeliver,
  type DeliverFn,
  type OutboundMail,
  type SmtpConfig,
} from "./smtp/mailer.js";
export { createSmtpMcpServer, type SmtpMcpServerOptions } from "./smtp/server.js";
export { createSmtpConnector } from "./smtp/connector.js";
export { oauth1Header, percentEncode, type OAuth1Credentials } from "./x/oauth1.js";
export { PostLog, type PostedTweet } from "./x/postlog.js";
export { createXMcpServer, type XServerOptions } from "./x/server.js";
export { createXConnector } from "./x/connector.js";
