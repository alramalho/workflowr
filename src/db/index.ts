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

db.exec(`
  CREATE TABLE IF NOT EXISTS org_members (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_id     TEXT NOT NULL UNIQUE,
    team_id      TEXT,
    name         TEXT NOT NULL,
    linear_id    TEXT,
    reports_to   TEXT,
    role         TEXT,
    writing_style TEXT,
    representative_example_message TEXT,
    is_external  INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// migrate: add representative_example_message to existing org_members tables
const orgCols = db.prepare(`PRAGMA table_info(org_members)`).all() as Array<{ name: string }>;
if (!orgCols.some((c) => c.name === "representative_example_message")) {
  db.exec(`ALTER TABLE org_members ADD COLUMN representative_example_message TEXT`);
}
if (!orgCols.some((c) => c.name === "linear_id")) {
  db.exec(`ALTER TABLE org_members ADD COLUMN linear_id TEXT`);
}
if (!orgCols.some((c) => c.name === "is_external")) {
  db.exec(`ALTER TABLE org_members ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS teams (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id  INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    UNIQUE(org_id, name)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS team_members (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    org_member_id INTEGER NOT NULL REFERENCES org_members(id) ON DELETE CASCADE,
    UNIQUE(team_id, org_member_id)
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
  CREATE TABLE IF NOT EXISTS org_guidelines (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id  TEXT,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    UNIQUE(key, team_id)
  )
`);

// seed default ticket creation guidelines
const hasTicketGuidelines = db.prepare(`SELECT 1 FROM org_guidelines WHERE key = 'ticket_creation'`).get();
if (!hasTicketGuidelines) {
  db.prepare(`INSERT INTO org_guidelines (team_id, key, value) VALUES (NULL, 'ticket_creation', ?)`).run(
    [
      "When creating Linear tickets, follow these rules:",
      "• Always create tickets in English, even if the original conversation is in another language (e.g. German).",
      "• Always assign the person who asked to create the ticket as the assignee. Use linear_list_members to resolve their Linear ID if needed.",
      "• For AI-related issues (hallucination, wrong information, bad tone, wrong recommendations):",
      '  - Add the "AI Debug" label.',
      '  - Add to the "AI (Achieve SOTA)" project.',
      "  - In the description, explain what went wrong and what the expected outcome should have been.",
      "  - Include the original message in italic as a quote, plus a translated English version if it's not in English. Example:",
      "    _Die KI hätte das Produkt XScreen nicht empfehlen sollen._",
      "    (The AI should have not recommended the product XScreen)",
      '  - If the issue is about something "not working" (functional bug), also add the "Bug" label.',
    ].join("\n"),
  );
}

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

export default db;
