import type { App } from "@slack/bolt";
import { runAgent, shouldRespond } from "../agent/index.js";
import { getThreadReplies, getChannelHistory, isChannelWritable, WRITABLE_CHANNELS } from "../integrations/slack.js";

export const ALLOWED_USERS: Record<string, string> = {
  "U08PH00GP9Q": "Alex",
  "U08U7U3AETF": "Aviral",
  "U09SF8QLZBP": "Vaibhav",
  "U0ACFP1UT2N": "Leandro",
  "U08BFN2670W": "Ergin",
  "U08L16TEDRR": "Melody",
};

let botUserId: string | undefined;
const activeThreads = new Set<string>();

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
    if (!("text" in message) || !message.text) return;
    if (!("user" in message)) return;
    if (!(message.user as string in ALLOWED_USERS)) {
      const isMentioned = message.text.includes(`<@${await getBotUserId(app)}>`);
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
    const isMentioned = message.text.includes(`<@${userId}>`);
    const threadTs = "thread_ts" in message ? message.thread_ts : undefined;
    const isActiveThread = threadTs && activeThreads.has(threadTs);

    if (!isMentioned && !isActiveThread && !isDM) return;

    const userMessage = message.text.replace(`<@${userId}>`, "").trim();
    if (!userMessage) return;

    const channel = message.channel;

    if (!isDM && !(await isChannelWritable(app, channel))) {
      await app.client.chat.postEphemeral({
        channel,
        user: message.user as string,
        text: `I'm not only allowed to respond publicly in this channel, only in ${Object.values(WRITABLE_CHANNELS).map((id) => `<#${id}>`).join(", ")}. Ask <@U08PH00GP9Q> if you need this changed.`,
      });
      return;
    }
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
          .map((m) => `<@${m.user}>: ${m.text}`)
          .join("\n");
        if (threadContext) context = `Thread context:\n${threadContext}`;
      } else {
        const history = await getChannelHistory(app, channel, 10);
        const channelContext = history
          .filter((m) => m.ts !== message.ts)
          .reverse()
          .map((m) => `<@${m.user}>: ${m.text}`)
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
      const response = await runAgent(app, userMessage, context || undefined, message.user, teamId, senderName);
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
