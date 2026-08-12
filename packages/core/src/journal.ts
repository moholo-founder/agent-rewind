import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type {
  ActionRecord,
  ActionStatus,
  RewindReport,
  SnapshotIndexEntry,
  SnapshotKind,
} from "./types.js";

/**
 * Append-only action journal on SQLite.
 *
 * Append-only is enforced at the database layer, not by convention:
 * triggers ABORT any DELETE on `actions`, and ABORT any UPDATE that touches
 * the immutable identity columns (id, ts, session, connector, tool, args,
 * class, caused_by). Only the lifecycle columns (status, executed_ts,
 * pre_state_ref, result_summary, blast_radius, risk_score) may change, and
 * status transitions are additionally whitelisted in code.
 */

const VALID_TRANSITIONS: Record<ActionStatus, ActionStatus[]> = {
  // pending → rejected covers a claimed approval whose args were lost.
  pending: ["executed", "failed", "held", "blocked-by-stop", "rejected"],
  // held → pending is the atomic "claim" an approval takes before its first
  // await, so a concurrent second approval sees pending and is refused.
  held: ["pending", "executed", "failed", "rejected"],
  executed: ["undone", "undo-failed"],
  // undo is idempotent; a failed undo may be retried and succeed.
  "undo-failed": ["undone", "undo-failed"],
  failed: [],
  "blocked-by-stop": [],
  rejected: [],
  undone: [],
};

export interface NewAction {
  sessionId: string;
  connector: string;
  tool: string;
  argsRedacted: unknown;
  class: ActionRecord["class"];
  riskScore: number;
  blastRadius: number;
  status: ActionStatus;
  preStateRef?: string | null;
  executedTs?: string | null;
  resultSummary?: string | null;
  causedBy?: string | null;
}

interface ActionRow {
  id: string;
  ts: string;
  executed_ts: string | null;
  session_id: string;
  connector: string;
  tool: string;
  args_redacted: string;
  class: ActionRecord["class"];
  risk_score: number;
  blast_radius: number;
  pre_state_ref: string | null;
  status: ActionStatus;
  result_summary: string | null;
  caused_by: string | null;
}

function rowToRecord(row: ActionRow): ActionRecord {
  return {
    id: row.id,
    ts: row.ts,
    executedTs: row.executed_ts,
    sessionId: row.session_id,
    connector: row.connector,
    tool: row.tool,
    argsRedacted: JSON.parse(row.args_redacted),
    class: row.class,
    riskScore: row.risk_score,
    blastRadius: row.blast_radius,
    preStateRef: row.pre_state_ref,
    status: row.status,
    resultSummary: row.result_summary,
    causedBy: row.caused_by,
  };
}

export class Journal {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    // Two runtimes pointing at the same journal (the default CLI path makes
    // this easy) must queue, not throw "database is locked".
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY NOT NULL,
        ts TEXT NOT NULL,
        executed_ts TEXT,
        session_id TEXT NOT NULL,
        connector TEXT NOT NULL,
        tool TEXT NOT NULL,
        args_redacted TEXT NOT NULL,
        class TEXT NOT NULL CHECK (class IN ('read','reversible','destructive','unknown')),
        risk_score REAL NOT NULL DEFAULT 0,
        blast_radius INTEGER NOT NULL DEFAULT 1,
        pre_state_ref TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'pending','executed','failed','held','blocked-by-stop','rejected','undone','undo-failed'
        )),
        result_summary TEXT,
        caused_by TEXT REFERENCES actions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions(ts);
      CREATE INDEX IF NOT EXISTS idx_actions_executed_ts ON actions(executed_ts);

      CREATE TABLE IF NOT EXISTS snapshots (
        ref TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('blob','tree','record')),
        bytes INTEGER NOT NULL,
        created_ts TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS rewind_sessions (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        anchor TEXT NOT NULL,
        report TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS control (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Append-only enforcement. The journal is evidence; history cannot be
      -- deleted, and an action's identity cannot be rewritten after the fact.
      -- Comparisons use IS NOT (never !=): with != a NULL on either side makes
      -- the WHEN clause NULL, the trigger silently skips, and identity could
      -- be destroyed via e.g. "SET id = NULL".
      DROP TRIGGER IF EXISTS actions_immutable_identity;

      CREATE TRIGGER IF NOT EXISTS actions_no_delete
        BEFORE DELETE ON actions
        BEGIN SELECT RAISE(ABORT, 'journal is append-only: DELETE forbidden'); END;

      CREATE TRIGGER actions_immutable_identity
        BEFORE UPDATE ON actions
        WHEN NEW.id IS NOT OLD.id
          OR NEW.ts IS NOT OLD.ts
          OR NEW.session_id IS NOT OLD.session_id
          OR NEW.connector IS NOT OLD.connector
          OR NEW.tool IS NOT OLD.tool
          OR NEW.args_redacted IS NOT OLD.args_redacted
          OR NEW.class IS NOT OLD.class
          OR NEW.caused_by IS NOT OLD.caused_by
        BEGIN SELECT RAISE(ABORT, 'journal is append-only: identity columns are immutable'); END;

      CREATE TRIGGER IF NOT EXISTS rewind_no_delete
        BEFORE DELETE ON rewind_sessions
        BEGIN SELECT RAISE(ABORT, 'rewind sessions are append-only'); END;

      CREATE TRIGGER IF NOT EXISTS rewind_no_update
        BEFORE UPDATE ON rewind_sessions
        BEGIN SELECT RAISE(ABORT, 'rewind sessions are append-only'); END;
    `);
  }

  // ---- actions -----------------------------------------------------------

  record(action: NewAction): ActionRecord {
    const id = randomUUID();
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO actions
          (id, ts, executed_ts, session_id, connector, tool, args_redacted,
           class, risk_score, blast_radius, pre_state_ref, status,
           result_summary, caused_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ts,
        action.executedTs ?? null,
        action.sessionId,
        action.connector,
        action.tool,
        JSON.stringify(action.argsRedacted ?? null),
        action.class,
        action.riskScore,
        action.blastRadius,
        action.preStateRef ?? null,
        action.status,
        action.resultSummary ?? null,
        action.causedBy ?? null,
      );
    return this.get(id);
  }

  get(id: string): ActionRecord {
    const row = this.db
      .prepare("SELECT * FROM actions WHERE id = ?")
      .get(id) as unknown as ActionRow | undefined;
    if (!row) throw new Error(`No journal entry with id ${id}`);
    return rowToRecord(row);
  }

  /**
   * Transition an action's lifecycle status. Only whitelisted transitions
   * are permitted — this is the one sanctioned mutation of a journal row.
   */
  transition(
    id: string,
    to: ActionStatus,
    patch: {
      executedTs?: string;
      preStateRef?: string | null;
      resultSummary?: string;
      blastRadius?: number;
    } = {},
  ): ActionRecord {
    const current = this.get(id);
    const allowed = VALID_TRANSITIONS[current.status];
    if (!allowed.includes(to)) {
      throw new Error(
        `Illegal status transition ${current.status} -> ${to} for action ${id}`,
      );
    }
    // The WHERE clause re-checks the status we validated against, closing the
    // check-then-act gap: if another writer transitioned the row in between,
    // this UPDATE matches nothing and we refuse instead of clobbering.
    const result = this.db
      .prepare(
        `UPDATE actions SET
           status = ?,
           executed_ts = COALESCE(?, executed_ts),
           pre_state_ref = COALESCE(?, pre_state_ref),
           result_summary = COALESCE(?, result_summary),
           blast_radius = COALESCE(?, blast_radius)
         WHERE id = ? AND status = ?`,
      )
      .run(
        to,
        patch.executedTs ?? null,
        patch.preStateRef ?? null,
        patch.resultSummary ?? null,
        patch.blastRadius ?? null,
        id,
        current.status,
      );
    if (result.changes !== 1) {
      const now = this.get(id);
      throw new Error(
        `Concurrent status change: expected ${current.status}, found ${now.status} for action ${id}`,
      );
    }
    return this.get(id);
  }

  list(opts: { limit?: number; sessionId?: string } = {}): ActionRecord[] {
    const limit = opts.limit ?? 1000;
    const rows = opts.sessionId
      ? (this.db
          .prepare(
            "SELECT * FROM actions WHERE session_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?",
          )
          .all(opts.sessionId, limit) as unknown as ActionRow[])
      : (this.db
          .prepare("SELECT * FROM actions ORDER BY ts DESC, rowid DESC LIMIT ?")
          .all(limit) as unknown as ActionRow[]);
    return rows.map(rowToRecord);
  }

  listHeld(): ActionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM actions WHERE status = 'held' ORDER BY ts ASC")
      .all() as unknown as ActionRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Actions eligible for rewind after the anchor: executed side-effecting
   * actions (not reads, not compensations) in strict reverse order of when
   * they *executed* — held-then-approved actions run out of journal order,
   * so `executed_ts` is the truth for LIFO undo.
   */
  listRewindable(anchorIso: string): ActionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM actions
         WHERE executed_ts IS NOT NULL
           AND executed_ts > ?
           AND class != 'read'
           AND caused_by IS NULL
           AND status IN ('executed', 'undo-failed')
         ORDER BY executed_ts DESC, rowid DESC`,
      )
      .all(anchorIso) as unknown as ActionRow[];
    return rows.map(rowToRecord);
  }

  // ---- snapshots index ---------------------------------------------------

  indexSnapshot(entry: SnapshotIndexEntry): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO snapshots (ref, kind, bytes, created_ts, meta)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.ref,
        entry.kind,
        entry.bytes,
        entry.createdTs,
        JSON.stringify(entry.meta),
      );
  }

  getSnapshotEntry(ref: string): SnapshotIndexEntry | null {
    const row = this.db
      .prepare("SELECT * FROM snapshots WHERE ref = ?")
      .get(ref) as unknown as
      | { ref: string; kind: SnapshotKind; bytes: number; created_ts: string; meta: string }
      | undefined;
    if (!row) return null;
    return {
      ref: row.ref,
      kind: row.kind,
      bytes: row.bytes,
      createdTs: row.created_ts,
      meta: JSON.parse(row.meta) as Record<string, unknown>,
    };
  }

  // ---- rewind sessions ---------------------------------------------------

  recordRewind(report: RewindReport): void {
    this.db
      .prepare(
        "INSERT INTO rewind_sessions (id, ts, anchor, report) VALUES (?, ?, ?, ?)",
      )
      .run(report.rewindId, report.startedTs, report.anchor, JSON.stringify(report));
  }

  listRewinds(): RewindReport[] {
    const rows = this.db
      .prepare("SELECT report FROM rewind_sessions ORDER BY ts DESC")
      .all() as unknown as { report: string }[];
    return rows.map((r) => JSON.parse(r.report) as RewindReport);
  }

  // ---- durable STOP flag -------------------------------------------------
  // Lives in Agent Rewind's own storage, outside any agent context, so context
  // compaction or a "creative" agent cannot erase it. Only an explicit
  // human resume() clears it.

  isStopped(): boolean {
    const row = this.db
      .prepare("SELECT value FROM control WHERE key = 'stopped'")
      .get() as unknown as { value: string } | undefined;
    return row?.value === "true";
  }

  setStopped(stopped: boolean): void {
    this.db
      .prepare(
        `INSERT INTO control (key, value) VALUES ('stopped', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(stopped ? "true" : "false");
  }

  close(): void {
    this.db.close();
  }
}
