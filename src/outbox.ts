import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Message } from "./tracker.ts";

export type Batch = {
  batch_id: string;
  messages: Message[];
};

export class Outbox {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        name TEXT NOT NULL,
        ts INTEGER NOT NULL,
        value REAL NOT NULL,
        batch_id TEXT,
        published INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (name, ts)
      )
    `);
    this.migrate();
    this.insert = this.db.prepare(
      "INSERT OR IGNORE INTO messages (name, ts, value) VALUES (?, ?, ?)",
    );
  }

  private migrate(): void {
    const cols = this.db.pragma("table_info(messages)") as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("batch_id")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN batch_id TEXT");
    }
    if (!names.has("published")) {
      this.db.exec(
        "ALTER TABLE messages ADD COLUMN published INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

  async append(message: Message): Promise<void> {
    this.insert.run(message.name, message.ts, message.value);
  }

  async all(): Promise<Message[]> {
    return this.db
      .prepare("SELECT name, ts, value FROM messages ORDER BY ts, name")
      .all() as Message[];
  }

  async claimBatch(limit = 5000): Promise<Batch | null> {
    return this.db.transaction(() => {
      const inFlight = this.db
        .prepare(
          `SELECT name, ts, value, batch_id FROM messages
           WHERE published = 0 AND batch_id IS NOT NULL
           ORDER BY ts, name`,
        )
        .all() as (Message & { batch_id: string })[];

      if (inFlight.length > 0) {
        const batch_id = inFlight[0].batch_id;
        return {
          batch_id,
          messages: inFlight
            .filter((m) => m.batch_id === batch_id)
            .map(({ name, ts, value }) => ({ name, ts, value })),
        };
      }

      const pending = this.db
        .prepare(
          `SELECT name, ts, value FROM messages
           WHERE published = 0 AND batch_id IS NULL
           ORDER BY ts, name
           LIMIT ?`,
        )
        .all(limit) as Message[];

      if (pending.length === 0) return null;

      const batch_id = randomUUID();
      const placeholders = pending.map(() => "(?, ?)").join(", ");
      const values = pending.flatMap((m) => [m.name, m.ts]);
      this.db
        .prepare(
          `UPDATE messages SET batch_id = ?
           WHERE (name, ts) IN (${placeholders})`,
        )
        .run(batch_id, ...values);
      return { batch_id, messages: pending };
    })();
  }

  async markPublished(batch_id: string): Promise<void> {
    this.db
      .prepare("UPDATE messages SET published = 1 WHERE batch_id = ?")
      .run(batch_id);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
