import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Journal } from "./journal.js";
import type { SnapshotKind, SnapshotStoreLike } from "./types.js";

/**
 * Content-addressed snapshot store: sha256(content) → file on disk under
 * <root>/<aa>/<sha256>, with an index row in the journal DB. Identical
 * content stores once (dedup for free); refs are stable and verifiable.
 */
export class SnapshotStore implements SnapshotStoreLike {
  constructor(
    private readonly root: string,
    private readonly journal: Journal,
  ) {
    fs.mkdirSync(root, { recursive: true });
  }

  private pathFor(ref: string): string {
    return path.join(this.root, ref.slice(0, 2), ref);
  }

  private put(content: Buffer, kind: SnapshotKind, meta: Record<string, unknown>): string {
    const ref = createHash("sha256").update(content).digest("hex");
    const target = this.pathFor(ref);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Write via temp file + fsync + rename: the dedup above trusts the
      // file's existence, so the bytes must be durable before the name is —
      // a crash-truncated blob under the right name would poison that
      // content's undo forever.
      const tmp = `${target}.tmp-${process.pid}`;
      const fd = fs.openSync(tmp, "w");
      try {
        fs.writeSync(fd, content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, target);
    }
    this.journal.indexSnapshot({
      ref,
      kind,
      bytes: content.byteLength,
      createdTs: new Date().toISOString(),
      meta,
    });
    return ref;
  }

  putBlob(content: Buffer, meta: Record<string, unknown> = {}): string {
    return this.put(content, "blob", meta);
  }

  /** Store a JSON-serializable value (tree manifests, message records...). */
  putRecord(value: unknown, meta: Record<string, unknown> = {}): string {
    const kind: SnapshotKind =
      typeof meta.kind === "string" && meta.kind === "tree" ? "tree" : "record";
    return this.put(Buffer.from(JSON.stringify(value), "utf8"), kind, meta);
  }

  getBlob(ref: string): Buffer {
    const target = this.pathFor(ref);
    const content = fs.readFileSync(target);
    // Verify integrity on read: a corrupted snapshot must fail loudly, not
    // silently restore garbage over the user's data.
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== ref) {
      throw new Error(
        `Snapshot ${ref} failed integrity check (content hashes to ${actual})`,
      );
    }
    return content;
  }

  getRecord<T = unknown>(ref: string): T {
    return JSON.parse(this.getBlob(ref).toString("utf8")) as T;
  }

  has(ref: string): boolean {
    return fs.existsSync(this.pathFor(ref));
  }
}
