import type { App } from "@slack/bolt";
import { runAgent, shouldRespond } from "../agent/index.js";
import { getThreadReplies, getChannelHistory } from "../integrations/slack.js";
import { downloadSlackImage, SUPPORTED_IMAGE_TYPES } from "../integrations/translate.js";
import { getOrgMemberBySlackId } from "../db/org-members.js";

export const ADMIN_USERS: Record<string, string> = {
  "U08PH00GP9Q": "Alex",
};

export const ALLOWED_USERS: Record<string, string> = {
  ...ADMIN_USERS,
  "U08U7U3AETF": "Aviral",
  "U09SF8QLZBP": "Vaibhav",
  "U0ACFP1UT2N": "Leandro",
  "U08BFN2670W": "Ergin",
  "U08L16TEDRR": "Melody",
};

let botUserId: string | undefined;
const activeThreads = new Set<string>();

function formatTimeAgo(ts: string): string {
  const msgTime = parseFloat(ts) * 1000;
  const diff = Date.now() - msgTime;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatReactions(m: any): string {
  if (!m.reactions?.length) return "";
  const entries = m.reactions.map((r: any) => {
    const names = (r.users ?? []).map((u: string) => getOrgMemberBySlackId(u)?.name ?? ALLOWED_USERS[u] ?? `<@${u}>`);
    return `${r.name}: [${names.join(", ")}]`;
  });
  return `\n> reactions: {${entries.join(", ")}}`;
}

async function getBotUserId(app: App): Promise<string> {
  if (!botUserId) {
    const auth = await app.client.auth.test();
    botUserId = auth.user_id as string;
  }
  return botUserId;
}

export function registerEvents(app: App) {
  app.message(async ({ message, say }) => {
    if (message.subtype) return;
    const hasFiles = "files" in message && Array.isArray((message as any).files) && (message as any).files.length > 0;
    if (!("text" in message) || !message.text) {
      if (!hasFiles) return;
    }
    if (!("user" in message)) return;
    if (!(message.user as string in ALLOWED_USERS)) {
      const text = ("text" in message && message.text) || "";
      const isMentioned = text.includes(`<@${await getBotUserId(app)}>`);
      if (isMentioned) {
        await app.client.chat.postEphemeral({
          channel: message.channel,
          user: message.user as string,
          text: "You're not allowed to trigger me. Talk to <@U08PH00GP9Q> if you want access.",
        });
      }
      return;
    }

    const userId = await getBotUserId(app);
    const isDM = "channel_type" in message && message.channel_type === "im";
    const messageText = ("text" in message && message.text) ? message.text : "";
    const isMentioned = messageText.includes(`<@${userId}>`);
    const threadTs = "thread_ts" in message ? message.thread_ts : undefined;
    const isActiveThread = threadTs && activeThreads.has(threadTs);

    if (!isMentioned && !isActiveThread && !isDM) return;

    let userMessage = messageText.replace(`<@${userId}>`, "").trim();

    // extract text from forwarded/quoted messages (attachments)
    if ("attachments" in message && Array.isArray(message.attachments)) {
      const attachmentText = message.attachments
        .map((a: any) => {
          const parts: string[] = [];
          if (a.author_name) parts.push(`${a.author_name}:`);
          if (a.text) parts.push(a.text);
          else if (a.fallback) parts.push(a.fallback);
          return parts.join(" ");
        })
        .filter(Boolean)
        .join("\n");
      if (attachmentText) userMessage += `\n\n[Attached/quoted message]\n${attachmentText}`;
    }

    // download images from message files
    const images: { data: Buffer; mimeType: string }[] = [];
    if ("files" in message && Array.isArray(message.files)) {
      const imgFiles = message.files.filter((f: any) => SUPPORTED_IMAGE_TYPES.has(f.mimetype));
      const downloaded = await Promise.all(
        imgFiles.map(async (f: any) => {
          try {
            const data = await downloadSlackImage(f.url_private);
            return { data, mimeType: f.mimetype as string };
          } catch (e) {
            console.error("Failed to download image:", e);
            return null;
          }
        }),
      );
      images.push(...downloaded.filter((d): d is NonNullable<typeof d> => d !== null));
    }

    if (!userMessage && !images.length) return;

    const channel = message.channel;

    const replyTs = threadTs ?? message.ts;

    // activate thread on first mention
    if (isMentioned && !isActiveThread) {
      activeThreads.add(replyTs);
    }

    let context = "";
    try {
      try { await app.client.conversations.join({ channel }); } catch {}
      if (threadTs) {
        const replies = await getThreadReplies(app, channel, threadTs);
        const threadContext = replies
          .filter((m) => m.ts !== message.ts)
          .map((m) => `[${formatTimeAgo(m.ts!)}] <@${m.user}>: ${m.text}${formatReactions(m)}`)
          .join("\n");
        if (threadContext) context = `Thread context:\n${threadContext}`;
      } else {
        const history = await getChannelHistory(app, channel, 10);
        const channelContext = history
          .filter((m) => m.ts !== message.ts)
          .reverse()
          .map((m) => `[${formatTimeAgo(m.ts!)}] <@${m.user}>: ${m.text}${formatReactions(m)}`)
          .join("\n");
        if (channelContext) context = `Recent channel messages:\n${channelContext}`;
      }
    } catch (e) {
      console.error("Failed to fetch thread/channel context:", e);
    }

    // gate: in active threads (without explicit mention), check if we should respond
    if (isActiveThread && !isMentioned) {
      const gate = await shouldRespond(context, userMessage);
      if (!gate) return;
    }

    await app.client.reactions.add({ channel, name: "eyes", timestamp: message.ts });

    try {
      const teamId = "team" in message ? (message.team as string | undefined) : undefined;
      const senderName = ALLOWED_USERS[message.user as string];
      const response = await runAgent(app, userMessage, context || undefined, message.user, teamId, senderName, images.length ? images : undefined, channel, threadTs ?? message.ts);
      await app.client.reactions.remove({ channel, name: "eyes", timestamp: message.ts });
      await say({ text: response || "I couldn't generate a response.", thread_ts: replyTs });
    } catch (error) {
      console.error("Agent error:", error);
      await app.client.reactions.remove({ channel, name: "eyes", timestamp: message.ts }).catch(() => {});
      await say({
        text: "Sorry, something went wrong while processing your request.",
        thread_ts: replyTs,
      });
    }
  });

  // Alex can delete bot messages by reacting with :x:
  app.event("reaction_added", async ({ event }) => {
    if (event.reaction !== "x" && event.reaction !== "heavy_multiplication_x") return;
    if (event.user !== "U08PH00GP9Q") return;

    const botId = await getBotUserId(app);
    if (event.item.type !== "message") return;

    try {
      const { messages } = await app.client.conversations.replies({
        channel: event.item.channel,
        ts: event.item.ts,
        limit: 1,
        inclusive: true,
      });
      const msg = messages?.[0];
      if (msg?.user !== botId && msg?.bot_id === undefined) return;

      await app.client.chat.delete({
        channel: event.item.channel,
        ts: event.item.ts,
      });
    } catch (e) {
      console.error("Failed to delete bot message:", e);
    }
  });
}
