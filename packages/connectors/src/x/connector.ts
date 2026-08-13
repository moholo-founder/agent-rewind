import type {
  CapabilityManifest,
  Compensator,
  CompensatorContext,
} from "@agentrewind/core";

/**
 * X (Twitter) connector: capability manifest + delete-tweet compensator.
 *
 * holdThreshold defaults to 0 — EVERY post is held for human approval. That
 * is the product promise for real outward-facing connectors: nothing goes
 * public without an operator clicking Approve.
 */

function firstTextJson<T>(result: unknown): T {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  const text = content?.find((c) => c.type === "text")?.text;
  if (text === undefined) throw new Error("Downstream returned no text content");
  return JSON.parse(text) as T;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`Missing string arg "${key}"`);
  return v;
}

interface PostPreState {
  kind: "x-post";
  text: string;
  /** Capture instant: disambiguates two posts with identical text. */
  capturedAt: string;
}

export function createXConnector(options: { holdThreshold?: number } = {}): {
  manifest: CapabilityManifest;
} {
  const postCompensator: Compensator = {
    async capture(args, ctx) {
      // The tweet id doesn't exist yet (capture runs strictly before
      // execution); the downstream server's post log resolves the id from
      // this identity at undo time.
      const pre: PostPreState = {
        kind: "x-post",
        text: str(args, "text"),
        capturedAt: new Date().toISOString(),
      };
      return ctx.snapshots.putRecord(pre, { connector: "x", tool: "post_tweet" });
    },
    async undo(entry, ctx: CompensatorContext) {
      if (!entry.preStateRef) {
        return { outcome: "failed" as const, detail: "No captured post identity" };
      }
      const pre = ctx.snapshots.getRecord<PostPreState>(entry.preStateRef);
      const result = firstTextJson<{ deleted: boolean; id?: string; reason: string }>(
        await ctx.callDownstream("admin__delete_tweet", {
          text: pre.text,
          after: pre.capturedAt,
        }),
      );
      return result.deleted
        ? { outcome: "undone" as const, detail: result.reason }
        : { outcome: "failed" as const, detail: result.reason };
    },
  };

  const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

  const manifest: CapabilityManifest = {
    connector: "x",
    holdThreshold: options.holdThreshold ?? 0,
    adminToolPrefix: "admin__",
    tools: {
      post_tweet: {
        class: "reversible",
        compensator: postCompensator,
        // Public visibility warrants more than the reversible default (0.4).
        riskScore: 0.7,
        blastRadius: () => 1,
        summarize: (a) => `Posted to X: "${truncate(a.text as string, 60)}"`,
      },
    },
  };

  return { manifest };
}
