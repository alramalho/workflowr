import type { App } from "@slack/bolt";
import { generateText } from "../utils/ai.js";
import dedent from "dedent";
import { config } from "../config.js";
import { getThreadReplies } from "./slack.js";

// per-user, per-thread: ts of last translated message
const translationHistory = new Map<string, string>();

export async function downloadSlackImage(url: string): Promise<Buffer> {
  const headers = { Authorization: `Bearer ${config.slack.botToken}` };
  let currentUrl = url;

  // Follow up to 5 redirects manually so we can keep the auth header
  for (let i = 0; i < 5; i++) {
    const res = await fetch(currentUrl, { headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect ${res.status} with no location header`);
      currentUrl = location;
      continue;
    }
    if (!res.ok) throw new Error(`Failed to download image: ${res.status} from ${currentUrl}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`Too many redirects downloading image: ${url}`);
}

async function describeImage(url: string, mimetype: string, messageContext: string, retries = 1): Promise<string | null> {
  try {
    if (!SUPPORTED_IMAGE_TYPES.has(mimetype)) return null;
    const buffer = await downloadSlackImage(url);
    const response = await generateText({
      model: "google/gemini-3-flash-preview",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `The user sent this message along with the image: "${messageContext}"\n\nDescribe what the image shows in the context of the message. Focus only on what's relevant to the user's point — ignore unrelated UI elements, sidebars, or background content. Translate any non-English text to English. Be concise. If the image has no relevance or readable content, respond with exactly: NO_TEXT`,
            },
            {
              type: "image",
              image: buffer,
              mediaType: mimetype,
            },
          ],
        },
      ],
    });
    const text = response.text?.trim();
    if (!text || text === "NO_TEXT") return null;
    return text;
  } catch (e) {
    console.error(`Image description failed (url=${url}, mime=${mimetype}, retriesLeft=${retries}):`, e);
    if (retries > 0) return describeImage(url, mimetype, messageContext, retries - 1);
    return null;
  }
}

export const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

async function processImageFiles(files: any[], messageContext: string): Promise<string> {
  const imgs = files?.filter((f: any) => f.mimetype?.startsWith("image/")) ?? [];
  if (!imgs.length) return "";
  const results = await Promise.all(
    imgs.map(async (f: any) => {
      const url = f.url_private_download ?? f.url_private;
      if (!url) {
        console.warn("Image file has no download URL:", JSON.stringify({ id: f.id, name: f.name, mimetype: f.mimetype }));
        return `[image ${f.mimetype}]`;
      }
      const translated = await describeImage(url, f.mimetype, messageContext);
      return translated ? `[image]\n${translated}` : `[image ${f.mimetype}]`;
    }),
  );
  return results.join("\n");
}

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
  files?: any[],
): Promise<string> {
  const mentionRe = /<@(U[A-Z0-9]+)>/g;
  const mentionIds = [...(messageText ?? "").matchAll(mentionRe)].map((m) => m[1]);
  const allIds = [...new Set([...(messageUser ? [messageUser] : []), ...mentionIds])];
  const names = allIds.length ? await resolveUserNames(app, allIds) : new Map<string, string>();
  const name = (messageUser && names.get(messageUser)) ?? "Someone";
  const resolvedText = messageText.replace(mentionRe, (_, id) => `@${names.get(id) ?? id}`);

  const imgText = files?.length ? await processImageFiles(files, messageText) : "";

  const result = await generateText({
    model: "google/gemini-3-flash-preview",
    prompt: dedent`
      Translate the following Slack message into English.
      If it's already in English, just restate it clearly.
      Output ONLY the translation, nothing else. No intro, no outro.
      Use this exact format (Slack mrkdwn):

      *${name}*: "translated message"

      Message: ${resolvedText}
    `,
  });

  const translated = result.text || "Couldn't translate the message.";
  return imgText ? `${translated}\n\n${imgText}` : translated;
}

export async function translateThread(
  app: App,
  channelId: string,
  threadTs: string,
  teamDomain: string,
  userId: string,
): Promise<string> {
  try { await app.client.conversations.join({ channel: channelId }); } catch {}
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

  // collect user IDs from both message authors and <@U...> mentions in text
  const mentionRe = /<@(U[A-Z0-9]+)>/g;
  const authorIds = messages.map((m) => m.user).filter(Boolean) as string[];
  const mentionIds = messages.flatMap((m) => [...(m.text ?? "").matchAll(mentionRe)].map((match) => match[1]));
  const userIds = [...new Set([...authorIds, ...mentionIds])];
  const names = await resolveUserNames(app, userIds);

  const lines = await Promise.all(messages.map(async (m) => {
    const name = names.get(m.user!) ?? m.user;
    const link = messageLink(teamDomain, channelId, m.ts!, threadTs);
    const date = new Date(parseFloat(m.ts!) * 1000).toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const files = (m as any).files as any[] | undefined;
    const imgText = files?.length ? await processImageFiles(files, m.text ?? "") : "";
    // replace <@U...> mentions with @DisplayName
    const rawText = (m.text ?? "").replace(mentionRe, (_, id) => `@${names.get(id) ?? id}`);
    const text = rawText + (imgText ? "\n\n" + imgText : "");
    return { name, text, link, date };
  }));

  const result = await generateText({
    model: "google/gemini-3-flash-preview",
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
