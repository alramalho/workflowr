import type { App } from "@slack/bolt";

const SLACK_AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope",
]);

export function isSlackAuthError(err: unknown): boolean {
  const code = (err as any)?.data?.error ?? (err as any)?.error ?? (err as any)?.message;
  return typeof code === "string" && [...SLACK_AUTH_ERRORS].some((e) => code.includes(e));
}

let botConnectionCache: { ok: boolean; reason?: string; checkedAt: number } | null = null;
const BOT_CONNECTION_TTL_MS = 60_000;

export async function checkBotConnection(app: App): Promise<{ ok: true } | { ok: false; reason: string }> {
  const now = Date.now();
  if (botConnectionCache && now - botConnectionCache.checkedAt < BOT_CONNECTION_TTL_MS) {
    return botConnectionCache.ok ? { ok: true } : { ok: false, reason: botConnectionCache.reason! };
  }
  try {
    await app.client.auth.test();
    botConnectionCache = { ok: true, checkedAt: now };
    return { ok: true };
  } catch (err) {
    const reason = (err as any)?.data?.error ?? (err as any)?.message ?? "unknown";
    botConnectionCache = { ok: false, reason, checkedAt: now };
    return { ok: false, reason };
  }
}

function slackToCanvasMentions(md: string): string {
  return md
    .replace(/<@(U[A-Z0-9]+)>/g, "![](@$1)")
    .replace(/<#(C[A-Z0-9]+)(?:\|[^>]*)?>/g, "![](#$1)");
}

export async function postMessage(
  app: App,
  channel: string,
  text: string,
  blocks?: any[]
) {
  return app.client.chat.postMessage({
    channel,
    text,
    blocks,
  });
}

export async function listChannels(
  app: App,
  opts: { nameFilter?: string; memberOnly?: boolean; limit?: number } = {}
) {
  const { nameFilter, memberOnly = false, limit = 100 } = opts;
  const needle = nameFilter?.toLowerCase();
  const results: { id: string; name: string; is_member: boolean; is_private: boolean }[] = [];
  let cursor: string | undefined;

  do {
    const res = await app.client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const ch of res.channels ?? []) {
      if (!ch.id || !ch.name) continue;
      if (memberOnly && !ch.is_member) continue;
      if (needle && !ch.name.toLowerCase().includes(needle)) continue;
      results.push({
        id: ch.id,
        name: ch.name,
        is_member: !!ch.is_member,
        is_private: !!ch.is_private,
      });
      if (results.length >= limit) return results;
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return results;
}

export async function getChannelHistory(
  app: App,
  channel: string,
  limit = 100
) {
  const { messages } = await app.client.conversations.history({
    channel,
    limit,
  });
  return messages ?? [];
}

export async function getThreadReplies(
  app: App,
  channel: string,
  threadTs: string
) {
  const { messages } = await app.client.conversations.replies({
    channel,
    ts: threadTs,
  });
  return messages ?? [];
}

export async function createCanvas(
  app: App,
  title?: string,
  markdown?: string
) {
  const content = markdown ? slackToCanvasMentions(markdown) : undefined;
  const res = await app.client.apiCall("canvases.create", {
    title,
    ...(content && {
      document_content: { type: "markdown", markdown: content },
    }),
  });
  return { canvas_id: (res as any).canvas_id };
}

export async function createChannelCanvas(
  app: App,
  channelId: string,
  title?: string,
  markdown?: string
) {
  const content = markdown ? slackToCanvasMentions(markdown) : undefined;
  const res = await app.client.apiCall("conversations.canvases.create", {
    channel_id: channelId,
    title,
    ...(content && {
      document_content: { type: "markdown", markdown: content },
    }),
  });
  return { canvas_id: (res as any).canvas_id };
}

export async function editCanvas(
  app: App,
  canvasId: string,
  operation: string,
  opts: { markdown?: string; sectionId?: string; title?: string } = {}
) {
  const change: Record<string, any> = { operation };
  if (opts.sectionId) change.section_id = opts.sectionId;
  if (opts.markdown) {
    change.document_content = { type: "markdown", markdown: slackToCanvasMentions(opts.markdown) };
  }
  if (opts.title) {
    change.title_content = { type: "markdown", markdown: opts.title };
  }
  return app.client.apiCall("canvases.edit", {
    canvas_id: canvasId,
    changes: [change],
  });
}

export async function listChannelCanvases(
  app: App,
  channelId: string
) {
  const canvases: { canvasId: string; title: string; source: string; channelName?: string }[] = [];

  const errors: string[] = [];

  // 1. Check the channel's primary canvas via conversations.info
  try {
    const info = await app.client.conversations.info({ channel: channelId });
    const channelName = (info.channel as any)?.name;
    const fileId = (info.channel as any)?.properties?.canvas?.file_id;
    if (fileId) {
      canvases.push({ canvasId: fileId, title: "(primary channel canvas)", source: "channel_property", channelName: channelName ? `#${channelName}` : channelId });
    }
  } catch (e: any) {
    errors.push(`conversations.info failed: ${e.data?.error ?? e.message}`);
  }

  // 2. List bookmarks
  try {
    const res = await app.client.apiCall("bookmarks.list", {
      channel_id: channelId,
    });
    const bookmarks = (res as any).bookmarks ?? [];
    for (const b of bookmarks) {
      const id = b.file_id ?? b.entity_id;
      if (id) {
        canvases.push({ canvasId: id, title: b.title ?? "(untitled)", source: "bookmark" });
      }
    }
  } catch (e: any) {
    errors.push(`bookmarks.list failed: ${e.data?.error ?? e.message}`);
  }

  // 3. Check pinned items
  try {
    const res = await app.client.pins.list({ channel: channelId });
    const existingIds = new Set(canvases.map(c => c.canvasId));
    for (const item of (res as any).items ?? []) {
      const f = item.file;
      if (f?.id && f?.filetype === "canvas" && !existingIds.has(f.id)) {
        canvases.push({ canvasId: f.id, title: f.title ?? f.name ?? "(untitled)", source: "pin" });
      }
    }
  } catch (e: any) {
    errors.push(`pins.list failed: ${e.data?.error ?? e.message}`);
  }

  // 4. List canvas files in channel (catches canvas tabs created via conversations.canvases.create)
  try {
    const res = await app.client.apiCall("files.list", {
      channel: channelId,
      types: "canvases",
    });
    const files = (res as any).files ?? [];
    const existingIds = new Set(canvases.map(c => c.canvasId));
    for (const f of files) {
      if (f.id && !existingIds.has(f.id)) {
        canvases.push({ canvasId: f.id, title: f.title ?? f.name ?? "(untitled)", source: "files_list" });
      }
    }
  } catch (e: any) {
    errors.push(`files.list failed: ${e.data?.error ?? e.message}`);
  }

  if (canvases.length === 0 && errors.length > 0) {
    return { canvases: [], errors, warning: "Could not list canvases — check bot permissions (bookmarks:read, channels:read)." };
  }
  return canvases;
}

export async function lookupCanvasSections(
  app: App,
  canvasId: string,
  criteria: { sectionTypes?: string[]; containsText?: string } = {}
) {
  const c: Record<string, any> = {};
  if (criteria.sectionTypes) c.section_types = criteria.sectionTypes;
  if (criteria.containsText) c.contains_text = criteria.containsText;
  if (!c.section_types && !c.contains_text) c.section_types = ["any_header"];
  const res = await app.client.apiCall("canvases.sections.lookup", {
    canvas_id: canvasId,
    criteria: c,
  });
  return (res as any).sections ?? [];
}
