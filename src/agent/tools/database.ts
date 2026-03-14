import { tool } from "ai";
import { z } from "zod";
import pg from "pg";
import * as sm from "../../integrations/supermemory.js";
import { config } from "../../config.js";
import type { ArtifactStore } from "../artifacts.js";

const FORBIDDEN_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE)\b/i,
  /\b(ATTACH|DETACH)\b/i,
  /\b(GRANT|REVOKE)\b/i,
  /\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i,
  /\b(VACUUM|REINDEX)\b/i,
];

function validateReadOnly(sql: string): { valid: boolean; reason?: string } {
  const trimmed = sql.trim().replace(/^--.*$/gm, "").trim();

  for (const pattern of FORBIDDEN_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return { valid: false, reason: `Blocked: "${match[0]}" operations are not allowed. This tool is read-only.` };
    }
  }

  const upper = trimmed.toUpperCase();
  if (!upper.startsWith("SELECT") && !upper.startsWith("EXPLAIN") && !upper.startsWith("WITH")) {
    return { valid: false, reason: `Blocked: query must start with SELECT, EXPLAIN, or WITH. Got: "${trimmed.slice(0, 30)}..."` };
  }

  return { valid: true };
}

function getPool() {
  const url = process.env.ORG_DATABASE_URL;
  if (!url) throw new Error("ORG_DATABASE_URL is not set");
  return new pg.Pool({ connectionString: url, max: 3 });
}

let pool: pg.Pool | null = null;

function getOrCreatePool() {
  if (!pool) pool = getPool();
  return pool;
}

function rowsToCsv(rows: Record<string, any>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map(h => {
      const val = row[h];
      const str = val == null ? "" : String(val);
      return str.includes(",") || str.includes('"') || str.includes("\n")
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    }).join(","));
  }
  return lines.join("\n");
}

export function createDatabaseTools(artifacts?: ArtifactStore) {
  const guidelinesAvailable = !!config.ai.supermemoryApiKey;

  const tools: Record<string, any> = {
    get_database_schema: tool({
      description: "List all tables and their columns/types in the org's database. Call this first to understand the schema before writing queries.",
      inputSchema: z.object({}),
      execute: async () => {
        const p = getOrCreatePool();
        const tables = await p.query(`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
          ORDER BY table_name
        `);

        const schema: Record<string, Array<{ column_name: string; data_type: string; is_nullable: string }>> = {};
        for (const { table_name } of tables.rows) {
          const cols = await p.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
            ORDER BY ordinal_position
          `, [table_name]);
          schema[table_name] = cols.rows;
        }

        return JSON.stringify(schema, null, 2);
      },
    }),

    execute_read_query: tool({
      description: "Execute a read-only SQL query against the org's database. Only SELECT, EXPLAIN, and WITH statements are allowed. Large result sets (>20 rows) are automatically stored as a downloadable CSV artifact — the response will include an artifactId.",
      inputSchema: z.object({
        sql: z.string().describe("The SQL query to execute. Must be a read-only query (SELECT, etc)."),
      }),
      execute: async ({ sql }) => {
        const validation = validateReadOnly(sql);
        if (!validation.valid) {
          return validation.reason!;
        }

        try {
          const p = getOrCreatePool();
          const result = await p.query(sql);
          if (result.rows.length === 0) return "Query returned no results.";

          if (result.rows.length > 20 && artifacts) {
            const csv = rowsToCsv(result.rows);
            const artifactId = artifacts.put(Buffer.from(csv, "utf-8"), "query-results.csv", "text/csv");
            return JSON.stringify({
              totalRows: result.rows.length,
              artifactId,
              message: `${result.rows.length} rows total. Full CSV stored as artifact "${artifactId}".`,
              preview: result.rows.slice(0, 10),
            }, null, 2);
          }

          return JSON.stringify(result.rows, null, 2);
        } catch (e: any) {
          return `SQL error: ${e.message}`;
        }
      },
    }),
  };

  if (guidelinesAvailable) {
    const tag = sm.dbSchemaTag();

    tools.search_db_guidelines = tool({
      description: "Search for known guidelines, gotchas, and tips about the database schema. ALWAYS call this before writing your first query to avoid known pitfalls (e.g. which table actually holds message counts, how orgs relate to agents, etc).",
      inputSchema: z.object({
        query: z.string().describe("What you want to know about the schema — e.g. 'how to count messages per org', 'what table has AI agent versions'"),
      }),
      execute: async ({ query }) => {
        const results = await sm.searchMemories(query, [tag], 5);
        if (results.length === 0) return "No guidelines found for this topic yet.";
        return results.map((r) => r.chunks?.map((c) => c.content).join("\n") ?? r.summary).join("\n---\n");
      },
    });

    tools.save_db_guideline = tool({
      description: "Save a new guideline about the database schema for future reference. Use this when you discover something non-obvious about the schema that would prevent mistakes (e.g. 'the messages table counts are per-conversation, not per-org — join through X to get org-level counts').",
      inputSchema: z.object({
        guideline: z.string().describe("The guideline to save — be specific about table names, fields, and the correct way to query"),
      }),
      execute: async ({ guideline }) => {
        await sm.addMemory(guideline, tag);
        return "Guideline saved.";
      },
    });
  }

  return tools;
}
