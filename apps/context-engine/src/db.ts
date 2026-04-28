import { PrismaClient } from "@prisma/client";
import { PrismaBetterSQLite3 } from "@prisma/adapter-better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const contextEngineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DB_PATH = path.resolve(contextEngineRoot, "data/context.db");

function resolveDatasourceUrl(raw: string | undefined): string {
  if (!raw) return `file:${DEFAULT_DB_PATH}`;
  if (!raw.startsWith("file:")) return raw;
  const filePath = raw.slice("file:".length);
  if (filePath === ":memory:" || path.isAbsolute(filePath)) return raw;
  return `file:${path.resolve(contextEngineRoot, "prisma", filePath)}`;
}

const datasourceUrl = resolveDatasourceUrl(process.env.CONTEXT_ENGINE_DATABASE_URL);
process.env.CONTEXT_ENGINE_DATABASE_URL = datasourceUrl;
const adapterUrl = datasourceUrl.startsWith("file:") ? datasourceUrl.slice("file:".length) : datasourceUrl;
if (adapterUrl !== ":memory:") {
  fs.mkdirSync(path.dirname(adapterUrl), { recursive: true });
}

const globalForPrisma = globalThis as unknown as {
  contextEnginePrisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.contextEnginePrisma ??
  new PrismaClient({
    adapter: new PrismaBetterSQLite3({ url: adapterUrl }, { timestampFormat: "iso8601" }),
    log: process.env.CONTEXT_ENGINE_DB_LOG === "1" ? ["query", "warn", "error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.contextEnginePrisma = prisma;
}

let connectionReady: Promise<void> | undefined;

export function ensureSchema(): Promise<void> {
  // Schema changes live in prisma/schema.prisma and are applied with the package db:push script.
  connectionReady ??= prisma.$connect();
  return connectionReady;
}

export function inferEntityType(filePath: string): string | null {
  if (filePath === "overview.mdx") return "Organization";
  const [root] = filePath.split("/");
  if (root === "people") return "Person";
  if (root === "teams") return "Team";
  if (root === "projects") return "Project";
  if (root === "repositories") return "Repository";
  if (root === "tickets") return "Ticket";
  if (root === "knowledge") return "Knowledge";
  if (root === "communications") return "Communication";
  return root ? root.replace(/(^|[-_])([a-z])/g, (_, p, c) => `${p}${c.toUpperCase()}`) : null;
}

export function extractLinks(content: string): string[] {
  const links = new Set<string>();
  for (const match of content.matchAll(/\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g)) {
    links.add(match[1]);
  }
  for (const match of content.matchAll(/\]\(@([^)]+)\)/g)) {
    links.add(match[1]);
  }
  return [...links];
}
