import type { App } from "@slack/bolt";
import { generateText } from "ai";
import { createHelicone } from "@helicone/ai-sdk-provider";
import OpenAI from "openai";
import dedent from "dedent";
import { config } from "../config.js";
import { getThreadReplies } from "./slack.js";

// per-user, per-thread: ts of last translated message
const translationHistory = new Map<string, string>();

async function downloadSlackImage(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.slack.botToken}` },
    redirect: "manual",
  });
  // Slack may redirect — follow with the same auth header
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (location) {
      const res2 = await fetch(location, {
        headers: { Authorization: `Bearer ${config.slack.botToken}` },
      });
      if (!res2.ok) throw new Error(`Failed to download image (redirect): ${res2.status}`);
      return Buffer.from(await res2.arrayBuffer());
    }
  }
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const openai = new OpenAI();

async function describeImage(url: string, mimetype: string): Promise<string | null> {
  try {
    if (!SUPPORTED_IMAGE_TYPES.has(mimetype)) return null;
    const buffer = await downloadSlackImage(url);
    const base64 = buffer.toString("base64");
    const response = await openai.responses.create({
      model: "gpt-4.1-nano",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Extract and translate any text visible in this image into English. If the text is already in English, just restate it. Output ONLY the translated text, nothing else. No intro, no outro. If there is no readable text in the image, respond with exactly: NO_TEXT",
            },
            {
              type: "input_image",
              image_url: `data:${mimetype};base64,${base64}`,
              detail: "auto",
            },
          ],
        },
      ],
    });
    const text = response.output_text?.trim();
    if (!text || text === "NO_TEXT") return null;
    return text;
  } catch (e) {
    console.error("Image description failed:", e);
    return null;
  }
}

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

async function processImageFiles(files: any[]): Promise<string> {
  const imgs = files?.filter((f: any) => f.mimetype?.startsWith("image/")) ?? [];
  if (!imgs.length) return "";
  const results = await Promise.all(
    imgs.map(async (f: any) => {
      const translated = await describeImage(f.url_private, f.mimetype);
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
  const names = messageUser ? await resolveUserNames(app, [messageUser]) : new Map();
  const name = (messageUser && names.get(messageUser)) ?? "Someone";

  const helicone = createHelicone({ apiKey: config.ai.heliconeApiKey, headers: { "Helicone-Property-App": "workflowr" } });
  const model = helicone("gemini-3-flash-preview");

  const imgText = files?.length ? await processImageFiles(files) : "";

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

  const userIds = [...new Set(messages.map((m) => m.user).filter(Boolean))] as string[];
  const names = await resolveUserNames(app, userIds);

  const helicone = createHelicone({ apiKey: config.ai.heliconeApiKey, headers: { "Helicone-Property-App": "workflowr" } });
  const model = helicone("gemini-3-flash-preview");

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
    const imgText = files?.length ? await processImageFiles(files) : "";
    const text = (m.text ?? "") + (imgText ? "\n\n" + imgText : "");
    return { name, text, link, date };
  }));

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
