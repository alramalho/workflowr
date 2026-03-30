import db from "./index.js";

export interface NotionPageRow {
  id: string;
  team_id: string;
  title: string;
  type: string;
  parent_id: string | null;
  parent_type: string | null;
  url: string | null;
  last_seen_at: string;
}

export function upsertNotionPage(page: {
  id: string;
  teamId: string;
  title: string;
  type: string;
  parentId?: string | null;
  parentType?: string | null;
  url?: string | null;
}): void {
  db.prepare(`
    INSERT INTO notion_pages (id, team_id, title, type, parent_id, parent_type, url, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id, team_id) DO UPDATE SET
      title = excluded.title,
      type = excluded.type,
      parent_id = excluded.parent_id,
      parent_type = excluded.parent_type,
      url = excluded.url,
      last_seen_at = datetime('now')
  `).run(page.id, page.teamId, page.title, page.type, page.parentId ?? null, page.parentType ?? null, page.url ?? null);
}

export function getNotionTree(teamId: string): NotionPageRow[] {
  return db.prepare(`
    SELECT * FROM notion_pages WHERE team_id = ? ORDER BY last_seen_at DESC
  `).all(teamId) as NotionPageRow[];
}

export function buildNotionTreeText(teamId: string): string | null {
  const rows = getNotionTree(teamId);
  if (rows.length === 0) return null;

  const byId = new Map<string, NotionPageRow>();
  const children = new Map<string, NotionPageRow[]>();
  const roots: NotionPageRow[] = [];

  for (const row of rows) {
    byId.set(row.id, row);
  }

  for (const row of rows) {
    if (!row.parent_id || !byId.has(row.parent_id)) {
      roots.push(row);
    } else {
      const siblings = children.get(row.parent_id) ?? [];
      siblings.push(row);
      children.set(row.parent_id, siblings);
    }
  }

  function renderNode(node: NotionPageRow, depth: number): string {
    const indent = "  ".repeat(depth);
    const icon = node.type === "database" ? "📊" : "📄";
    const line = `${indent}${icon} ${node.title} [id: ${node.id}]`;
    const kids = children.get(node.id) ?? [];
    const kidLines = kids.map((k) => renderNode(k, depth + 1));
    return [line, ...kidLines].join("\n");
  }

  const lines = roots.map((r) => renderNode(r, 0));
  return lines.join("\n");
}
