import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = process.env.DB_PATH ?? path.resolve("data", "tokens.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS google_tokens (
    slack_user_id TEXT PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    email         TEXT,
    connected_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    slack_id        TEXT UNIQUE,
    linear_id       TEXT,
    github_username TEXT,
    metadata        TEXT NOT NULL DEFAULT '{}'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS orgs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    github_org     TEXT,
    linear_team_id TEXT,
    metadata       TEXT NOT NULL DEFAULT '{}'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS delayed_jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    key        TEXT NOT NULL UNIQUE,
    payload    TEXT NOT NULL DEFAULT '{}',
    run_at     TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export default db;
