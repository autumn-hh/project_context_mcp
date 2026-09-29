import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type SqliteDatabase = Database.Database;

export function openDatabase(path: string): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    // Apply the wait policy before journal setup, which can itself need a lock.
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
