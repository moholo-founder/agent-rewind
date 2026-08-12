import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Backing store for the self-contained mock email server. Entirely local
 * SQLite — no external OAuth, so the flagship demo runs anywhere.
 *
 * Folders: inbox | sent | outbox | __trash | __recalled.
 * - Deletes move messages to __trash (recoverable, never destroyed).
 * - send_message parks the message in outbox until deliver_after; a recall
 *   within that window moves it to __recalled instead of sent.
 */

export type EmailFolder = "inbox" | "sent" | "outbox" | "__trash" | "__recalled";

export interface EmailMessage {
  id: string;
  folder: EmailFolder;
  from: string;
  to: string;
  subject: string;
  body: string;
  ts: string;
  /** ISO time after which an outbox message is delivered; null otherwise. */
  deliverAfter: string | null;
}

interface Row {
  id: string;
  folder: EmailFolder;
  from_addr: string;
  to_addr: string;
  subject: string;
  body: string;
  ts: string;
  deliver_after: string | null;
}

function rowToMessage(row: Row): EmailMessage {
  return {
    id: row.id,
    folder: row.folder,
    from: row.from_addr,
    to: row.to_addr,
    subject: row.subject,
    body: row.body,
    ts: row.ts,
    deliverAfter: row.deliver_after,
  };
}

export class EmailStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        folder TEXT NOT NULL CHECK (folder IN ('inbox','sent','outbox','__trash','__recalled')),
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        ts TEXT NOT NULL,
        deliver_after TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder);
    `);
  }

  insert(msg: Omit<EmailMessage, "id"> & { id?: string }): EmailMessage {
    const id = msg.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO messages (id, folder, from_addr, to_addr, subject, body, ts, deliver_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, msg.folder, msg.from, msg.to, msg.subject, msg.body, msg.ts, msg.deliverAfter);
    return this.get(id)!;
  }

  get(id: string): EmailMessage | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? rowToMessage(row) : null;
  }

  list(folder: EmailFolder, limit = 500): EmailMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE folder = ? ORDER BY ts DESC LIMIT ?")
      .all(folder, limit) as Row[];
    return rows.map(rowToMessage);
  }

  count(folder: EmailFolder): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE folder = ?")
      .get(folder) as { n: number };
    return row.n;
  }

  moveTo(id: string, folder: EmailFolder): EmailMessage {
    const msg = this.get(id);
    if (!msg) throw new Error(`No message with id ${id}`);
    this.db.prepare("UPDATE messages SET folder = ? WHERE id = ?").run(folder, id);
    return this.get(id)!;
  }

  /** Move every message in a folder to __trash. Returns the moved ids. */
  trashFolder(folder: EmailFolder): string[] {
    const ids = this.list(folder, 100_000).map((m) => m.id);
    const stmt = this.db.prepare("UPDATE messages SET folder = '__trash' WHERE id = ?");
    const tx = this.db.transaction((all: string[]) => {
      for (const id of all) stmt.run(id);
    });
    tx(ids);
    return ids;
  }

  send(params: { from: string; to: string; subject: string; body: string; deliveryWindowMs: number }): EmailMessage {
    const now = new Date();
    return this.insert({
      folder: "outbox",
      from: params.from,
      to: params.to,
      subject: params.subject,
      body: params.body,
      ts: now.toISOString(),
      deliverAfter: new Date(now.getTime() + params.deliveryWindowMs).toISOString(),
    });
  }

  /** Deliver every outbox message whose window has elapsed. Returns count. */
  deliverDue(now = new Date()): number {
    const rows = this.db
      .prepare("SELECT id FROM messages WHERE folder = 'outbox' AND deliver_after <= ?")
      .all(now.toISOString()) as { id: string }[];
    for (const { id } of rows) {
      this.db
        .prepare("UPDATE messages SET folder = 'sent', deliver_after = NULL WHERE id = ?")
        .run(id);
    }
    return rows.length;
  }

  /**
   * Recall an outbox message (undo of send within the window). Honest about
   * why it can't when the window has elapsed.
   */
  cancelSend(match: { to: string; subject: string }): { canceled: boolean; reason: string; id?: string } {
    const inOutbox = this.db
      .prepare(
        "SELECT * FROM messages WHERE folder = 'outbox' AND to_addr = ? AND subject = ? ORDER BY ts DESC LIMIT 1",
      )
      .get(match.to, match.subject) as Row | undefined;
    if (inOutbox) {
      this.moveTo(inOutbox.id, "__recalled");
      return { canceled: true, reason: "Recalled from outbox before delivery", id: inOutbox.id };
    }
    const delivered = this.db
      .prepare(
        "SELECT * FROM messages WHERE folder = 'sent' AND to_addr = ? AND subject = ? ORDER BY ts DESC LIMIT 1",
      )
      .get(match.to, match.subject) as Row | undefined;
    if (delivered) {
      return {
        canceled: false,
        reason: "Delivery window elapsed — the message was already delivered and cannot be recalled",
        id: delivered.id,
      };
    }
    const recalled = this.db
      .prepare(
        "SELECT * FROM messages WHERE folder = '__recalled' AND to_addr = ? AND subject = ? ORDER BY ts DESC LIMIT 1",
      )
      .get(match.to, match.subject) as Row | undefined;
    if (recalled) {
      return { canceled: true, reason: "Already recalled", id: recalled.id };
    }
    return { canceled: false, reason: "No matching message found" };
  }

  close(): void {
    this.db.close();
  }
}
