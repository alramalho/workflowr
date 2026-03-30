import { Client, collectPaginatedAPI, isFullPage, isFullBlock, isFullDataSource } from "@notionhq/client";
import type {
  BlockObjectResponse,
  PageObjectResponse,
  DataSourceObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import { config } from "../config.js";
import { upsertNotionPage } from "../db/notion-pages.js";

const client = new Client({ auth: config.notion.apiKey });

function extractParentInfo(parent: { type: string; [k: string]: any }): { parentId: string | null; parentType: string } {
  switch (parent.type) {
    case "page_id": return { parentId: parent.page_id, parentType: "page" };
    case "database_id": return { parentId: parent.database_id, parentType: "database" };
    case "data_source_id": return { parentId: parent.data_source_id, parentType: "database" };
    case "workspace": return { parentId: null, parentType: "workspace" };
    default: return { parentId: null, parentType: parent.type };
  }
}

function recordPage(page: { id: string; title: string; type: string; parent?: any; url?: string }, teamId?: string) {
  if (!teamId) return;
  const { parentId, parentType } = page.parent ? extractParentInfo(page.parent) : { parentId: null, parentType: "workspace" };
  try {
    upsertNotionPage({ id: page.id, teamId, title: page.title, type: page.type, parentId, parentType, url: page.url });
  } catch {}
}

async function resolveParentTitle(parentId: string, parentType: string, teamId?: string) {
  if (!teamId || !parentId) return;
  try {
    if (parentType === "page") {
      const parent = await client.pages.retrieve({ page_id: parentId });
      if (isFullPage(parent)) {
        recordPage({ id: parent.id, title: extractPageTitle(parent), type: "page", parent: parent.parent, url: parent.url }, teamId);
      }
    } else if (parentType === "database") {
      try {
        const ds = await client.dataSources.retrieve({ data_source_id: parentId });
        if (isFullDataSource(ds)) {
          recordPage({ id: ds.id, title: richTextToPlain(ds.title), type: "database", url: ds.url }, teamId);
        }
      } catch {
        const db = await client.databases.retrieve({ database_id: parentId });
        if ("title" in db && db.title) {
          recordPage({ id: db.id, title: richTextToPlain(db.title as any), type: "database", url: (db as any).url }, teamId);
        }
      }
    }
  } catch {}
}

function richTextToPlain(rt: RichTextItemResponse[]): string {
  return rt.map((t) => t.plain_text).join("");
}

function extractPageTitle(page: PageObjectResponse): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title") {
      return richTextToPlain(prop.title);
    }
  }
  return "(untitled)";
}

function extractPropertyValue(prop: PageObjectResponse["properties"][string]): unknown {
  switch (prop.type) {
    case "title": return richTextToPlain(prop.title);
    case "rich_text": return richTextToPlain(prop.rich_text);
    case "number": return prop.number;
    case "select": return prop.select?.name ?? null;
    case "multi_select": return prop.multi_select.map((s) => s.name);
    case "date": return prop.date;
    case "checkbox": return prop.checkbox;
    case "url": return prop.url;
    case "email": return prop.email;
    case "phone_number": return prop.phone_number;
    case "status": return prop.status?.name ?? null;
    case "people": return prop.people.map((p) => ("name" in p ? p.name : p.id));
    case "relation": return prop.relation.map((r) => r.id);
    case "formula":
      if (prop.formula.type === "string") return prop.formula.string;
      if (prop.formula.type === "number") return prop.formula.number;
      if (prop.formula.type === "boolean") return prop.formula.boolean;
      if (prop.formula.type === "date") return prop.formula.date;
      return null;
    default: return null;
  }
}

function blockToText(block: BlockObjectResponse): string {
  const b = block as any;
  const type = block.type;
  const data = b[type];
  if (!data) return "";

  if (data.rich_text) {
    const text = richTextToPlain(data.rich_text);
    switch (type) {
      case "heading_1": return `# ${text}`;
      case "heading_2": return `## ${text}`;
      case "heading_3": return `### ${text}`;
      case "bulleted_list_item": return `• ${text}`;
      case "numbered_list_item": return `1. ${text}`;
      case "to_do": return `${data.checked ? "☑" : "☐"} ${text}`;
      case "toggle": return `▸ ${text}`;
      case "quote": return `> ${text}`;
      case "callout": return `💡 ${text}`;
      default: return text;
    }
  }

  if (type === "code") return `\`\`\`${data.language ?? ""}\n${richTextToPlain(data.rich_text)}\n\`\`\``;
  if (type === "divider") return "---";
  if (type === "image") return `[Image: ${data.caption ? richTextToPlain(data.caption) : data.external?.url ?? data.file?.url ?? ""}]`;
  if (type === "bookmark") return `[Bookmark: ${data.url}]`;
  if (type === "table_row") return data.cells.map((cell: RichTextItemResponse[]) => richTextToPlain(cell)).join(" | ");

  return "";
}

function formatDsProperties(properties: DataSourceObjectResponse["properties"]) {
  return Object.entries(properties).map(([name, prop]) => {
    const base: Record<string, unknown> = { name, type: prop.type };
    if (prop.type === "select") base.options = prop.select.options.map((o: any) => o.name);
    if (prop.type === "multi_select") base.options = prop.multi_select.options.map((o: any) => o.name);
    if (prop.type === "status") base.options = prop.status.options.map((o: any) => o.name);
    return base;
  });
}

export async function searchPages(query: string, limit = 10, teamId?: string) {
  const response = await client.search({
    query,
    filter: { value: "page", property: "object" },
    page_size: limit,
  });
  const pages = response.results.filter(isFullPage);
  const results = pages.map((page) => ({
    id: page.id,
    title: extractPageTitle(page),
    url: page.url,
    lastEdited: page.last_edited_time,
  }));

  // record pages + resolve parents in background
  for (const page of pages) {
    const title = extractPageTitle(page);
    const { parentId, parentType } = extractParentInfo(page.parent);
    recordPage({ id: page.id, title, type: "page", parent: page.parent, url: page.url }, teamId);
    if (parentId) resolveParentTitle(parentId, parentType, teamId);
  }

  return results;
}

export async function searchDatabases(query: string, limit = 10, teamId?: string) {
  const response = await client.search({
    query,
    filter: { value: "data_source", property: "object" },
    page_size: limit,
  });
  const dataSources = response.results.filter(isFullDataSource);
  const results = dataSources.map((ds) => ({
    id: ds.id,
    title: richTextToPlain(ds.title),
    url: ds.url,
    properties: formatDsProperties(ds.properties),
  }));

  for (const ds of dataSources) {
    recordPage({ id: ds.id, title: richTextToPlain(ds.title), type: "database", url: ds.url }, teamId);
  }

  return results;
}

export async function getPageContent(pageId: string, maxDepth = 2, teamId?: string): Promise<string> {
  const page = await client.pages.retrieve({ page_id: pageId });
  const title = isFullPage(page) ? extractPageTitle(page) : "(untitled)";

  if (isFullPage(page)) {
    const { parentId, parentType } = extractParentInfo(page.parent);
    recordPage({ id: page.id, title, type: "page", parent: page.parent, url: page.url }, teamId);
    if (parentId) resolveParentTitle(parentId, parentType, teamId);
  }

  async function getBlocks(blockId: string, depth: number): Promise<string[]> {
    const blocks = await collectPaginatedAPI(client.blocks.children.list, { block_id: blockId });
    const lines: string[] = [];
    for (const block of blocks) {
      if (!isFullBlock(block)) continue;
      const text = blockToText(block);
      const indent = "  ".repeat(Math.max(0, depth - 1));
      if (text) lines.push(`${indent}${text}`);
      if (block.has_children && depth < maxDepth) {
        const children = await getBlocks(block.id, depth + 1);
        lines.push(...children);
      }
    }
    return lines;
  }

  const content = await getBlocks(pageId, 0);
  return `# ${title}\n\n${content.join("\n")}`;
}

export async function getPageProperties(pageId: string, teamId?: string) {
  const page = await client.pages.retrieve({ page_id: pageId });
  if (!isFullPage(page)) return null;
  const title = extractPageTitle(page);
  const props: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(page.properties)) {
    props[name] = extractPropertyValue(prop);
  }

  const { parentId, parentType } = extractParentInfo(page.parent);
  recordPage({ id: page.id, title, type: "page", parent: page.parent, url: page.url }, teamId);
  if (parentId) resolveParentTitle(parentId, parentType, teamId);

  return { id: page.id, title, url: page.url, properties: props };
}

export async function queryDatabase(
  dataSourceId: string,
  filter?: Record<string, unknown>,
  sorts?: Array<{ property: string; direction: "ascending" | "descending" }>,
  limit = 20,
) {
  const params: any = {
    data_source_id: dataSourceId,
    page_size: Math.min(limit, 100),
  };
  if (filter) params.filter = filter;
  if (sorts) params.sorts = sorts;

  const response = await client.dataSources.query(params);
  return response.results
    .filter(isFullPage)
    .map((page) => {
      const props: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries(page.properties)) {
        props[name] = extractPropertyValue(prop);
      }
      return {
        id: page.id,
        url: page.url,
        properties: props,
      };
    });
}

export async function getDatabaseSchema(dataSourceId: string, teamId?: string) {
  const ds = await client.dataSources.retrieve({ data_source_id: dataSourceId });
  if (!isFullDataSource(ds)) return null;
  const title = richTextToPlain(ds.title);
  recordPage({ id: ds.id, title, type: "database", url: ds.url }, teamId);
  return { id: ds.id, title, url: ds.url, properties: formatDsProperties(ds.properties) };
}
