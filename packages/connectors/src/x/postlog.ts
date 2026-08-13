import fs from "node:fs";
import path from "node:path";

/**
 * Append-only log of tweets this server posted, keyed by content identity.
 *
 * The delete-tweet compensator captures pre-state BEFORE the post executes,
 * so it can never know the tweet id — only (text, capture instant). This log
 * is the id lookup at undo time, persisted as JSONL so undo survives a
 * runtime restart.
 */

export interface PostedTweet {
  id: string;
  text: string;
  /** ISO instant the post was recorded. */
  ts: string;
  deleted?: boolean;
}

type LogLine =
  | { op: "post"; id: string; text: string; ts: string }
  | { op: "delete"; id: string };

export class PostLog {
  private readonly entries: PostedTweet[] = [];

  constructor(private readonly filePath?: string) {
    if (!filePath || !fs.existsSync(filePath)) return;
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let parsed: LogLine;
      try {
        parsed = JSON.parse(line) as LogLine;
      } catch {
        continue; // a torn trailing write must not poison the whole log
      }
      if (parsed.op === "post") {
        this.entries.push({ id: parsed.id, text: parsed.text, ts: parsed.ts });
      } else if (parsed.op === "delete") {
        const entry = this.entries.find((e) => e.id === parsed.id);
        if (entry) entry.deleted = true;
      }
    }
  }

  private append(line: LogLine): void {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(line)}\n`);
  }

  record(post: { id: string; text: string; ts: string }): void {
    this.entries.push({ ...post });
    this.append({ op: "post", ...post });
  }

  markDeleted(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) entry.deleted = true;
    this.append({ op: "delete", id });
  }

  /**
   * Earliest live post with this exact text at/after `after` — same
   * disambiguation rule as the mock email's cancel_send, so two identical
   * posts each undo THEIR OWN tweet.
   */
  find(text: string, after?: string): PostedTweet | undefined {
    return this.entries.find(
      (e) => !e.deleted && e.text === text && (!after || e.ts >= after),
    );
  }
}
