import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.resolve(__dirname, "../../data", "tokens.db");

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
  CREATE TABLE IF NOT EXISTS slack_tokens (
    slack_user_id TEXT PRIMARY KEY,
    access_token  TEXT NOT NULL,
    connected_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS orgs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    team_id        TEXT UNIQUE,
    url            TEXT,
    description    TEXT,
    industry       TEXT,
    location       TEXT,
    github_org     TEXT,
    linear_team_id TEXT,
    metadata       TEXT NOT NULL DEFAULT '{}'
  )
`);

// migrate: add new columns to existing orgs tables
const orgTableCols = db.prepare(`PRAGMA table_info(orgs)`).all() as Array<{ name: string }>;
if (!orgTableCols.some((c) => c.name === "team_id")) {
  db.exec(`ALTER TABLE orgs ADD COLUMN team_id TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS orgs_team_id_unique ON orgs(team_id)`);
}
if (!orgTableCols.some((c) => c.name === "url")) {
  db.exec(`ALTER TABLE orgs ADD COLUMN url TEXT`);
}
if (!orgTableCols.some((c) => c.name === "description")) {
  db.exec(`ALTER TABLE orgs ADD COLUMN description TEXT`);
}
if (!orgTableCols.some((c) => c.name === "industry")) {
  db.exec(`ALTER TABLE orgs ADD COLUMN industry TEXT`);
}
if (!orgTableCols.some((c) => c.name === "location")) {
  db.exec(`ALTER TABLE orgs ADD COLUMN location TEXT`);
}
if (!orgTableCols.some((c) => c.name === "slack_domain")) {
  db.exec(`ALTER TABLE orgs ADD COLUMN slack_domain TEXT`);
}

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

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    team_id     TEXT,
    title       TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS task_steps (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    parent_step_id  INTEGER REFERENCES task_steps(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    instructions    TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT 'action',
    schedule        TEXT,
    tools_needed    TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'pending_confirmation',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_id   TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    thread_ts   TEXT,
    message_ts  TEXT,
    prompt      TEXT NOT NULL,
    response    TEXT,
    tool_calls  TEXT NOT NULL DEFAULT '[]',
    latency_ms  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS artifacts (
    id         TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    thread_ts  TEXT NOT NULL,
    filename   TEXT NOT NULL,
    mime_type  TEXT NOT NULL,
    summary    TEXT,
    content    BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS tool_rules (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name      TEXT NOT NULL,
    memory_text    TEXT NOT NULL,
    slack_user_id  TEXT NOT NULL,
    team_id        TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tool_name, memory_text, slack_user_id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS usage_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          TEXT NOT NULL,
    user_name        TEXT,
    team_id          TEXT,
    invocation_type  TEXT NOT NULL,
    channel_id       TEXT,
    thread_ts        TEXT,
    tool_calls_count INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS notion_pages (
    id          TEXT NOT NULL,
    team_id     TEXT NOT NULL,
    title       TEXT NOT NULL,
    type        TEXT NOT NULL,
    parent_id   TEXT,
    parent_type TEXT,
    url         TEXT,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (id, team_id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS runners (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    team_id      TEXT NOT NULL,
    token        TEXT NOT NULL UNIQUE,
    status       TEXT NOT NULL DEFAULT 'pending',
    cwd          TEXT,
    last_seen_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS runner_directories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    runner_id   TEXT NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(runner_id, name)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS org_files (
    team_id     TEXT NOT NULL,
    path        TEXT NOT NULL,
    parent_path TEXT NOT NULL,
    name        TEXT NOT NULL,
    frontmatter TEXT NOT NULL DEFAULT '{}',
    content     TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (team_id, path)
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_org_files_parent ON org_files(team_id, parent_path)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS secrets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    value       TEXT NOT NULL,
    created_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(team_id, name)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS skills (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    trigger     TEXT NOT NULL DEFAULT '{}',
    action      TEXT NOT NULL DEFAULT '{}',
    created_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(team_id, name)
  )
`);

export default db;
