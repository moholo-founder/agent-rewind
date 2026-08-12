import type {
  ActionClass,
  CapabilityManifest,
  GateDecision,
} from "./types.js";

/**
 * The policy gate: classify → decide. Pure and synchronous by design so its
 * behavior is trivially testable and auditable.
 *
 * Order of checks matters and encodes the safety posture:
 *   1. Reads always pass (never gated, never snapshotted) — trust and
 *      performance depend on this.
 *   2. STOP beats everything else side-effecting.
 *   3. Tools the connector never declared are unknown → held, not executed.
 *   4. Blast radius over the connector threshold → held.
 *   5. Otherwise: snapshot + execute.
 */
export function gate(params: {
  manifest: CapabilityManifest | undefined;
  tool: string;
  toolClass: ActionClass;
  blastRadius: number;
  stopped: boolean;
}): GateDecision {
  const { manifest, tool, toolClass, blastRadius, stopped } = params;

  if (toolClass === "read") return { verdict: "pass-read" };

  if (stopped) return { verdict: "block-stop" };

  if (!manifest || !(tool in manifest.tools) || toolClass === "unknown") {
    return {
      verdict: "hold",
      reason: `Tool "${tool}" is not declared by any connector manifest — held for human approval (safety-by-default).`,
    };
  }

  // A malformed radius (NaN/Infinity from a broken downstream count) must
  // fail CLOSED: `NaN > threshold` is false, which would sail a
  // delete-everything through as "execute" if we only kept the > check.
  if (!Number.isFinite(blastRadius) || blastRadius < 0) {
    return {
      verdict: "hold",
      reason: `Blast radius could not be determined (${blastRadius}) — held for human approval.`,
    };
  }

  if (blastRadius > manifest.holdThreshold) {
    return {
      verdict: "hold",
      reason: `Blast radius ${blastRadius} exceeds ${manifest.connector} threshold of ${manifest.holdThreshold}.`,
    };
  }

  return { verdict: "execute" };
}

/** Default display risk per class, used when a tool doesn't declare one. */
export function defaultRiskScore(toolClass: ActionClass): number {
  switch (toolClass) {
    case "read":
      return 0;
    case "reversible":
      return 0.4;
    case "destructive":
      return 0.8;
    case "unknown":
      return 1;
  }
}
