import db from "../db/index.js";

export interface OrgFile {
  team_id: string;
  path: string;
  parent_path: string;
  name: string;
  frontmatter: Record<string, any>;
  content: string;
  updated_at: string;
}

interface RawRow {
  team_id: string;
  path: string;
  parent_path: string;
  name: string;
  frontmatter: string;
  content: string;
  updated_at: string;
}

function parseRow(row: RawRow): OrgFile {
  return {
    ...row,
    frontmatter: JSON.parse(row.frontmatter),
  };
}

function parsePath(filePath: string): { parentPath: string; name: string } {
  const parts = filePath.split("/");
  const name = parts.pop()!;
  const parentPath = parts.join("/") || ".";
  return { parentPath, name };
}

// --- reads ---

export function ls(teamId: string, dirPath: string): string[] {
  const normalized = dirPath.replace(/\/$/, "") || ".";

  // direct children (files in this directory)
  const files = db
    .prepare(`SELECT name FROM org_files WHERE team_id = ? AND parent_path = ? ORDER BY name`)
    .all(teamId, normalized) as { name: string }[];

  // subdirectories: find distinct next-level parent paths
  const prefix = normalized === "." ? "" : normalized + "/";
  const allPaths = db
    .prepare(`SELECT DISTINCT parent_path FROM org_files WHERE team_id = ? AND parent_path LIKE ? AND parent_path != ?`)
    .all(teamId, `${prefix}%`, normalized) as { parent_path: string }[];

  const subdirs = new Set<string>();
  for (const { parent_path } of allPaths) {
    const relative = prefix ? parent_path.slice(prefix.length) : parent_path;
    const topLevel = relative.split("/")[0];
    if (topLevel) subdirs.add(topLevel + "/");
  }

  return [...subdirs, ...files.map((f) => f.name)].sort();
}

export function cat(teamId: string, filePath: string): string | null {
  const row = db
    .prepare(`SELECT frontmatter, content FROM org_files WHERE team_id = ? AND path = ?`)
    .get(teamId, filePath) as Pick<RawRow, "frontmatter" | "content"> | undefined;

  if (!row) return null;

  const fm = JSON.parse(row.frontmatter);
  const fmLines = Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v).replace(/\n/g, " ")}`)
    .join("\n");

  if (!fmLines) return row.content;
  return `---\n${fmLines}\n---\n\n${row.content}`;
}

export function grep(teamId: string, pattern: string, scope?: string): { path: string; matches: string[] }[] {
  const lowerPattern = pattern.toLowerCase();

  let rows: { path: string; frontmatter: string; content: string }[];
  if (scope) {
    const normalized = scope.replace(/\/$/, "");
    rows = db
      .prepare(`SELECT path, frontmatter, content FROM org_files WHERE team_id = ? AND (parent_path = ? OR parent_path LIKE ? OR path = ?)`)
      .all(teamId, normalized, `${normalized}/%`, normalized) as any[];
  } else {
    rows = db
      .prepare(`SELECT path, frontmatter, content FROM org_files WHERE team_id = ?`)
      .all(teamId) as any[];
  }

  const results: { path: string; matches: string[] }[] = [];
  for (const row of rows) {
    const fullText = `${row.frontmatter}\n${row.content}`.toLowerCase();
    if (fullText.includes(lowerPattern)) {
      const lines = `${row.frontmatter}\n${row.content}`.split("\n");
      const matching = lines.filter((l) => l.toLowerCase().includes(lowerPattern));
      results.push({ path: row.path, matches: matching.slice(0, 5) });
    }
  }
  return results;
}

// --- writes ---

export function writeFile(
  teamId: string,
  filePath: string,
  frontmatter: Record<string, any>,
  content: string,
): void {
  const { parentPath, name } = parsePath(filePath);
  db.prepare(`
    INSERT INTO org_files (team_id, path, parent_path, name, frontmatter, content, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(team_id, path) DO UPDATE SET
      frontmatter = excluded.frontmatter,
      content = excluded.content,
      updated_at = excluded.updated_at
  `).run(teamId, filePath, parentPath, name, JSON.stringify(frontmatter), content);
}

export function deleteFile(teamId: string, filePath: string): void {
  db.prepare(`DELETE FROM org_files WHERE team_id = ? AND path = ?`).run(teamId, filePath);
}

// --- helpers ---

export function readFrontmatter(teamId: string, filePath: string): Record<string, any> | null {
  const row = db
    .prepare(`SELECT frontmatter FROM org_files WHERE team_id = ? AND path = ?`)
    .get(teamId, filePath) as { frontmatter: string } | undefined;
  return row ? JSON.parse(row.frontmatter) : null;
}

export function countFiles(teamId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM org_files WHERE team_id = ?`)
    .get(teamId) as { count: number };
  return row.count;
}

export function fileExists(teamId: string, filePath: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM org_files WHERE team_id = ? AND path = ?`)
    .get(teamId, filePath);
  return !!row;
}

export function findByFrontmatter(teamId: string, key: string, value: string, scope?: string): OrgFile[] {
  let rows: RawRow[];
  if (scope) {
    const normalized = scope.replace(/\/$/, "");
    rows = db
      .prepare(`SELECT * FROM org_files WHERE team_id = ? AND (parent_path = ? OR parent_path LIKE ?) AND json_extract(frontmatter, ?) = ?`)
      .all(teamId, normalized, `${normalized}/%`, `$.${key}`, value) as RawRow[];
  } else {
    rows = db
      .prepare(`SELECT * FROM org_files WHERE team_id = ? AND json_extract(frontmatter, ?) = ?`)
      .all(teamId, `$.${key}`, value) as RawRow[];
  }
  return rows.map(parseRow);
}

export function allFilesInDir(teamId: string, dirPath: string): OrgFile[] {
  const normalized = dirPath.replace(/\/$/, "") || ".";
  const rows = db
    .prepare(`SELECT * FROM org_files WHERE team_id = ? AND parent_path = ? ORDER BY name`)
    .all(teamId, normalized) as RawRow[];
  return rows.map(parseRow);
}
