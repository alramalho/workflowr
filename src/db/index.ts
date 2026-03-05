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
  CREATE TABLE IF NOT EXISTS org_members (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_id     TEXT NOT NULL UNIQUE,
    team_id      TEXT,
    name         TEXT NOT NULL,
    reports_to   TEXT,
    role         TEXT,
    writing_style TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS thread_reads (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id   TEXT NOT NULL,
    thread_ts    TEXT NOT NULL,
    last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(channel_id, thread_ts)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS issue_thread_links (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_identifier TEXT NOT NULL,
    channel_id       TEXT NOT NULL,
    thread_ts        TEXT NOT NULL,
    resolved         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(issue_identifier, channel_id, thread_ts)
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
