import { tool } from "ai";
import { z } from "zod";
import * as notion from "../../integrations/notion.js";
import type { SubagentContext } from "./types.js";

export function createNotionTools(ctx: SubagentContext) {
  const { teamId } = ctx;

  return {
    notion_search_pages: tool({
      description: "Search Notion pages by title/keyword",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional().describe("Max results (default 10)"),
      }),
      execute: async ({ query, limit }) => notion.searchPages(query, limit, teamId),
    }),
    notion_search_databases: tool({
      description: "Search Notion databases by name",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional().describe("Max results (default 10)"),
      }),
      execute: async ({ query, limit }) => notion.searchDatabases(query, limit, teamId),
    }),
    notion_read_page: tool({
      description: "Read a Notion page's full content (rendered as markdown). Use after searching to get the actual page body.",
      inputSchema: z.object({
        pageId: z.string().describe("Notion page ID"),
      }),
      execute: async ({ pageId }) => notion.getPageContent(pageId, 2, teamId),
    }),
    notion_get_page_properties: tool({
      description: "Get a Notion page's metadata and property values (without body content)",
      inputSchema: z.object({
        pageId: z.string().describe("Notion page ID"),
      }),
      execute: async ({ pageId }) => notion.getPageProperties(pageId, teamId),
    }),
    notion_get_database_schema: tool({
      description: "Get a Notion database's schema (column names, types, select options). Useful before querying.",
      inputSchema: z.object({
        databaseId: z.string().describe("Notion database ID"),
      }),
      execute: async ({ databaseId }) => notion.getDatabaseSchema(databaseId, teamId),
    }),
    notion_query_database: tool({
      description: "Query a Notion database with optional filters and sorting. Check schema first with notion_get_database_schema.",
      inputSchema: z.object({
        databaseId: z.string().describe("Notion database ID"),
        filter: z.record(z.string(), z.unknown()).optional().describe("Notion filter object (see Notion API docs)"),
        sorts: z.array(z.object({
          property: z.string(),
          direction: z.enum(["ascending", "descending"]),
        })).optional().describe("Sort criteria"),
        limit: z.number().optional().describe("Max results (default 20)"),
      }),
      execute: async ({ databaseId, filter, sorts, limit }) =>
        notion.queryDatabase(databaseId, filter, sorts, limit),
    }),
  };
}
