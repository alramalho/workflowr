import { Prisma } from "@prisma/client";
import { ensureSchema, extractLinks, inferEntityType, prisma } from "./db.js";

export interface OrgFile {
  team_id: string;
  path: string;
  parent_path: string;
  name: string;
  entity_type: string | null;
  frontmatter: Record<string, any>;
  content: string;
  links: string[];
  source: string | null;
  updated_at: string;
}

export interface SearchResult {
  path: string;
  score: number;
  frontmatter: Record<string, any>;
  content: string;
  matches: string[];
}

function parsePath(filePath: string): { parentPath: string; name: string } {
  const parts = filePath.split("/");
  const name = parts.pop()!;
  const parentPath = parts.join("/") || ".";
  return { parentPath, name };
}

function normalizeDirPath(dirPath: string): string {
  return dirPath.replace(/\/$/, "") || ".";
}

function frontmatterToText(frontmatter: Record<string, any>): string {
  return Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v).replace(/\n/g, " ")}`)
    .join("\n");
}

function safeParseObject(text: string): Record<string, any> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeParseStringArray(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toOrgFile(row: {
  teamId: string;
  path: string;
  parentPath: string;
  name: string;
  entityType: string | null;
  frontmatter: string;
  content: string;
  links: string;
  source: string | null;
  updatedAt: Date;
}): OrgFile {
  return {
    team_id: row.teamId,
    path: row.path,
    parent_path: row.parentPath,
    name: row.name,
    entity_type: row.entityType,
    frontmatter: safeParseObject(row.frontmatter),
    content: row.content,
    links: safeParseStringArray(row.links),
    source: row.source,
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function ls(teamId: string, dirPath: string): Promise<string[]> {
  await ensureSchema();
  const normalized = normalizeDirPath(dirPath);
  const rows = await prisma.contextPage.findMany({
    where: { teamId },
    select: { parentPath: true, name: true },
    orderBy: { name: "asc" },
  });

  const files = rows
    .filter((row) => row.parentPath === normalized)
    .map((row) => row.name);

  const prefix = normalized === "." ? "" : normalized + "/";
  const subdirs = new Set<string>();
  for (const row of rows) {
    if (row.parentPath === normalized) continue;
    if (!row.parentPath.startsWith(prefix)) continue;
    const relative = prefix ? row.parentPath.slice(prefix.length) : row.parentPath;
    const topLevel = relative.split("/")[0];
    if (topLevel) subdirs.add(topLevel + "/");
  }

  return [...subdirs, ...files].sort();
}

export async function cat(teamId: string, filePath: string): Promise<string | null> {
  await ensureSchema();
  const row = await prisma.contextPage.findUnique({
    where: { teamId_path: { teamId, path: filePath } },
    select: { frontmatter: true, content: true },
  });
  if (!row) return null;

  const frontmatter = safeParseObject(row.frontmatter);
  const fmLines = frontmatterToText(frontmatter);
  if (!fmLines) return row.content;
  return `---\n${fmLines}\n---\n\n${row.content}`;
}

export async function grep(
  teamId: string,
  pattern: string,
  scope?: string,
): Promise<{ path: string; matches: string[] }[]> {
  await ensureSchema();
  const rows = await scopedRows(teamId, scope);
  const lowerPattern = pattern.toLowerCase();
  const results: { path: string; matches: string[] }[] = [];

  for (const row of rows) {
    const fullText = `${row.frontmatter}\n${row.content}`;
    if (fullText.toLowerCase().includes(lowerPattern)) {
      const lines = fullText.split("\n");
      const matching = lines.filter((line) => line.toLowerCase().includes(lowerPattern));
      results.push({ path: row.path, matches: matching.slice(0, 5) });
    }
  }

  return results;
}

export async function searchPages(
  teamId: string,
  query: string,
  limit = 8,
  scope?: string,
): Promise<SearchResult[]> {
  await ensureSchema();
  const rows = await scopedRows(teamId, scope);
  const terms = query.toLowerCase().match(/[a-z0-9_@.-]+/g) ?? [];

  return rows
    .map((row) => {
      const text = `${row.path}\n${row.frontmatter}\n${row.content}`;
      const lower = text.toLowerCase();
      const score = terms.reduce((sum, term) => sum + countOccurrences(lower, term), 0);
      return {
        path: row.path,
        score,
        frontmatter: safeParseObject(row.frontmatter),
        content: row.content,
        matches: bestMatchingLines(text, terms),
      };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function scopedRows(teamId: string, scope?: string) {
  await ensureSchema();
  const normalized = scope ? normalizeDirPath(scope) : undefined;
  const rows = await prisma.contextPage.findMany({
    where: { teamId },
    orderBy: { updatedAt: "desc" },
  });

  if (!normalized) return rows;
  return rows.filter(
    (row) =>
      row.path === normalized ||
      row.parentPath === normalized ||
      row.parentPath.startsWith(`${normalized}/`),
  );
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let index = text.indexOf(term);
  while (index !== -1) {
    count++;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

function bestMatchingLines(text: string, terms: string[]): string[] {
  const lines = text.split("\n");
  return lines
    .map((line) => {
      const lower = line.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      return { line, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((row) => row.line);
}

export async function writeFile(
  teamId: string,
  filePath: string,
  frontmatter: Record<string, any>,
  content: string,
  options?: { entityType?: string; source?: string },
): Promise<void> {
  await ensureSchema();
  const { parentPath, name } = parsePath(filePath);
  const links = extractLinks(`${JSON.stringify(frontmatter)}\n${content}`);

  await prisma.contextPage.upsert({
    where: { teamId_path: { teamId, path: filePath } },
    create: {
      teamId,
      path: filePath,
      parentPath,
      name,
      entityType: options?.entityType ?? inferEntityType(filePath),
      frontmatter: JSON.stringify(frontmatter),
      content,
      links: JSON.stringify(links),
      source: options?.source ?? null,
    },
    update: {
      parentPath,
      name,
      entityType: options?.entityType ?? inferEntityType(filePath),
      frontmatter: JSON.stringify(frontmatter),
      content,
      links: JSON.stringify(links),
      source: options?.source ?? null,
    },
  });
}

export async function deleteFile(teamId: string, filePath: string): Promise<void> {
  await ensureSchema();
  await prisma.contextPage.delete({ where: { teamId_path: { teamId, path: filePath } } }).catch((error) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return;
    throw error;
  });
}

export async function readFrontmatter(teamId: string, filePath: string): Promise<Record<string, any> | null> {
  await ensureSchema();
  const row = await prisma.contextPage.findUnique({
    where: { teamId_path: { teamId, path: filePath } },
    select: { frontmatter: true },
  });
  return row ? safeParseObject(row.frontmatter) : null;
}

export async function countFiles(teamId: string): Promise<number> {
  await ensureSchema();
  return prisma.contextPage.count({ where: { teamId } });
}

export async function fileExists(teamId: string, filePath: string): Promise<boolean> {
  await ensureSchema();
  const count = await prisma.contextPage.count({ where: { teamId, path: filePath } });
  return count > 0;
}

export async function findByFrontmatter(
  teamId: string,
  key: string,
  value: string,
  scope?: string,
): Promise<OrgFile[]> {
  await ensureSchema();
  const rows = await scopedRows(teamId, scope);
  return rows
    .filter((row) => String(safeParseObject(row.frontmatter)[key] ?? "") === value)
    .map(toOrgFile);
}

export async function allFilesInDir(teamId: string, dirPath: string): Promise<OrgFile[]> {
  await ensureSchema();
  const normalized = normalizeDirPath(dirPath);
  const rows = await prisma.contextPage.findMany({
    where: { teamId, parentPath: normalized },
    orderBy: { name: "asc" },
  });
  return rows.map(toOrgFile);
}
