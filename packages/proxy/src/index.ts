/**
 * @backstop/proxy — MCP interception proxy.
 *
 * M0 stub. In M3 this becomes an MCP server (facing the agent) plus an MCP
 * client (facing downstream servers), with classification, the policy gate
 * (allow / snapshot+execute / hold / block), the persistent STOP flag, and
 * journaling with SSE emission.
 */
import type { ActionClass } from "@backstop/core";

export const PROXY_PACKAGE = "@backstop/proxy";

/** Placeholder to prove the cross-package type dependency compiles. */
export function classifyPlaceholder(): ActionClass {
  // Safety default: anything we don't understand is "unknown" (held, never
  // silently executed). Real classification lands in M3.
  return "unknown";
}
