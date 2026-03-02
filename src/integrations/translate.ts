import type { App } from "@slack/bolt";
import { generateText } from "ai";
import { createHelicone } from "@helicone/ai-sdk-provider";
import dedent from "dedent";
import { config } from "../config.js";
import { getThreadReplies } from "./slack.js";

// per-user, per-thread: ts of last translated message
const translationHistory = new Map<string, string>();

function historyKey(userId: string, threadTs: string) {
  return `${userId}:${threadTs}`;
}

function messageLink(teamDomain: string, channelId: string, ts: string, threadTs?: string): string {
  const pTs = "p" + ts.replace(".", "");
  const base = `https://${teamDomain}.slack.com/archives/${channelId}/${pTs}`;
  if (threadTs && threadTs !== ts) {
    return `${base}?thread_ts=${threadTs}&cid=${channelId}`;
  }
  return base;
}

async function resolveUserNames(
  app: App,
  userIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    userIds.map(async (id) => {
      try {
        const res = await app.client.users.info({ user: id });
        names.set(
          id,
          res.user?.profile?.display_name || res.user?.real_name || id,
        );
      } catch {
        names.set(id, id);
      }
    }),
  );
  return names;
}

export async function translateMessage(
  app: App,
  channelId: string,
  messageTs: string,
  messageText: string,
  messageUser: string | undefined,
  teamDomain: string,
): Promise<string> {
  const names = messageUser ? await resolveUserNames(app, [messageUser]) : new Map();
  const name = (messageUser && names.get(messageUser)) ?? "Someone";

  const helicone = createHelicone({ apiKey: config.ai.heliconeApiKey });
  const model = helicone(config.ai.model);

  const result = await generateText({
    model,
    prompt: dedent`
      Translate the following Slack message into English.
      If it's already in English, just restate it clearly.
      Output ONLY the translation, nothing else. No intro, no outro.
      Use this exact format (Slack mrkdwn):

      *${name}*: "translated message"

      Message: ${messageText}
    `,
  });

  return result.text || "Couldn't translate the message.";
}

export async function translateThread(
  app: App,
  channelId: string,
  threadTs: string,
  teamDomain: string,
  userId: string,
): Promise<string> {
  const allMessages = await getThreadReplies(app, channelId, threadTs);

  if (!allMessages.length) {
    return "Couldn't find any messages in that thread.";
  }

  const key = historyKey(userId, threadTs);
  const lastTranslatedTs = translationHistory.get(key);

  const messages = lastTranslatedTs
    ? allMessages.filter((m) => m.ts! > lastTranslatedTs)
    : allMessages;

  if (!messages.length) {
    return "No new messages since last translation.";
  }

  const userIds = [...new Set(messages.map((m) => m.user).filter(Boolean))] as string[];
  const names = await resolveUserNames(app, userIds);

  const lines = messages.map((m) => {
    const name = names.get(m.user!) ?? m.user;
    const link = messageLink(teamDomain, channelId, m.ts!, threadTs);
    const date = new Date(parseFloat(m.ts!) * 1000).toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const files = (m as any).files as any[] | undefined;
    const imgs = files?.filter((f: any) => f.mimetype?.startsWith("image/")) ?? [];
    const text = (m.text ?? "") + (imgs.length ? "\n\n" + imgs.map(() => "[image]").join(" ") : "");
    return { name, text, link, date };
  });

  const helicone = createHelicone({ apiKey: config.ai.heliconeApiKey });
  const model = helicone(config.ai.model);

  const result = await generateText({
    model,
    prompt: dedent`
      Translate the following Slack thread messages into English.
      If a message is already in English, keep it as-is.
      IMPORTANT: Preserve the original message formatting VERBATIM — keep all bullet points, bold, links, line breaks, etc. Only change the language to English.
      Group messages by their date.
      Output ONLY the grouped messages, nothing else. No intro, no outro.
      Use this exact format:

      # Day, DD Mon YYYY

      ## Name <link|said>
      > translated message preserving original formatting

      ## Name <link|said>
      > translated message preserving original formatting

      # Next Day, DD Mon YYYY

      ## Name <link|said>
      > translated message preserving original formatting

      Here are the messages to translate:
      ${lines.map((l) => `===\nDate: ${l.date}\nName: ${l.name}\nLink: ${l.link}\nMessage:\n${l.text}\n===`).join("\n")}
    `,
  });

  // track last translated message
  const lastMsg = messages[messages.length - 1];
  translationHistory.set(key, lastMsg.ts!);

  if (!result.text) return "Couldn't translate the thread.";

  // prepend link to previous translation if this is a delta
  if (lastTranslatedTs) {
    const prevLink = messageLink(teamDomain, channelId, lastTranslatedTs, threadTs);
    return `(<${prevLink}|Previous translation>)\n\n${result.text}`;
  }

  return result.text;
}
