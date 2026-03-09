import type { App } from "@slack/bolt";

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
  const canvases: { canvasId: string; title: string; source: string }[] = [];

  // 1. Check the channel's primary canvas via conversations.info
  try {
    const info = await app.client.conversations.info({ channel: channelId });
    const fileId = (info.channel as any)?.properties?.canvas?.file_id;
    if (fileId) {
      canvases.push({ canvasId: fileId, title: "(primary channel canvas)", source: "channel_property" });
    }
  } catch {}

  // 2. List bookmarks - canvas tabs appear here
  try {
    const res = await app.client.apiCall("bookmarks.list", {
      channel_id: channelId,
    });
    const bookmarks = (res as any).bookmarks ?? [];
    for (const b of bookmarks) {
      if (b.file_id) {
        canvases.push({ canvasId: b.file_id, title: b.title ?? "(untitled)", source: "bookmark" });
      }
    }
  } catch {}

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
