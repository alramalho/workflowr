import type { App } from "@slack/bolt";
import { runAgent, shouldRespond } from "../agent/index.js";
import { getThreadReplies, getChannelHistory, isChannelWritable, WRITABLE_CHANNELS } from "../integrations/slack.js";

const ALLOWED_USERS = new Set([
  "U08PH00GP9Q", // Alex
  "U08U7U3AETF", // Aviral
  "U09SF8QLZBP", // Vaibhav
  "U0ACFP1UT2N", // Leandro
]);

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
    if (!("user" in message) || !ALLOWED_USERS.has(message.user as string)) return;

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
    } catch {
      // proceed without context if fetching fails
    }

    // gate: in active threads (without explicit mention), check if we should respond
    if (isActiveThread && !isMentioned) {
      const gate = await shouldRespond(context, userMessage);
      if (!gate) return;
    }

    await app.client.reactions.add({ channel, name: "eyes", timestamp: message.ts });

    try {
      const teamId = "team" in message ? (message.team as string | undefined) : undefined;
      const response = await runAgent(app, userMessage, context || undefined, message.user, teamId);
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
}
