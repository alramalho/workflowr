import type { App } from "@slack/bolt";

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
