import type { App } from "@slack/bolt";
import { shouldRespond } from "../agent/index.js";
import { getThreadReplies } from "../integrations/slack.js";
import { downloadSlackImage, SUPPORTED_IMAGE_TYPES } from "../integrations/translate.js";
import { findPersonBySlackId } from "../org/propagate.js";
import { getOrgByTeamId } from "../db/orgs.js";
import { getThreadArtifacts } from "../db/artifacts.js";
import { getThreadBotCalls } from "../db/bot-calls.js";
import { enqueueAgentJob } from "../queues/agent-queue.js";
import { logUsage } from "../db/usage-log.js";

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

async function formatReactions(m: any): Promise<string> {
  if (!m.reactions?.length) return "";
  const entries = await Promise.all(m.reactions.map(async (r: any) => {
    const names = await Promise.all((r.users ?? []).map(async (u: string) => {
      const person = await findPersonBySlackId(m.team, u);
      return person?.frontmatter.name ?? ALLOWED_USERS[u] ?? `<@${u}>`;
    }));
    return `${r.name}: [${names.join(", ")}]`;
  }));
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

    // download images and files from message files
    const images: { data: Buffer; mimeType: string }[] = [];
    const files: { data: Buffer; mimeType: string; name: string }[] = [];
    if ("files" in message && Array.isArray(message.files)) {
      await Promise.all(
        message.files.map(async (f: any) => {
          try {
            const data = await downloadSlackImage(f.url_private);
            if (SUPPORTED_IMAGE_TYPES.has(f.mimetype)) {
              images.push({ data, mimeType: f.mimetype });
            } else if (f.mimetype === "application/pdf") {
              files.push({ data, mimeType: f.mimetype, name: f.name });
            }
          } catch (e) {
            console.error(`Failed to download file ${f.name}:`, e);
          }
        }),
      );
    }

    if (!userMessage && !images.length && !files.length) return;

    const channel = message.channel;

    const replyTs = threadTs ?? message.ts;

    // activate thread on first mention
    if (isMentioned && !isActiveThread) {
      activeThreads.add(replyTs);
    }

    let context = "";
    const myId = await getBotUserId(app);
    const senderLabel = (m: any) => {
      if (m.user === myId) return "workflowr (you)";
      if (m.bot_id || m.bot_profile) return `[app: ${(m.bot_profile as any)?.name ?? m.username ?? "unknown bot"}]`;
      return `<@${m.user}>`;
    };
    try {
      try { await app.client.conversations.join({ channel }); } catch {}
      if (threadTs) {
        const replies = await getThreadReplies(app, channel, threadTs);
        const otherMessages = replies.filter((m) => m.ts !== message.ts);
        const threadContext = (await Promise.all(otherMessages
          .map(async (m) => {
            let line = `[${formatTimeAgo(m.ts!)}] ${senderLabel(m)}: ${m.text}${await formatReactions(m)}`;
            if ((m as any).files && Array.isArray((m as any).files)) {
              const imgs = (m as any).files
                .filter((f: any) => SUPPORTED_IMAGE_TYPES.has(f.mimetype))
                .map((f: any) => `[image: ${f.name}]`);
              if (imgs.length) line += ` ${imgs.join(" ")}`;
            }
            return line;
          })))
          .join("\n");
        if (threadContext) context = `Thread context:\n${threadContext}`;

        // download images from thread context messages so the model can actually see them
        const threadImageFiles = otherMessages.flatMap((m) =>
          ((m as any).files ?? []).filter((f: any) => SUPPORTED_IMAGE_TYPES.has(f.mimetype))
        );
        await Promise.all(
          threadImageFiles.map(async (f: any) => {
            try {
              const data = await downloadSlackImage(f.url_private);
              images.push({ data, mimeType: f.mimetype });
            } catch (e) {
              console.error(`Failed to download thread image ${f.name}:`, e);
            }
          }),
        );
      }
    } catch (e) {
      console.error("Failed to fetch thread/channel context:", e);
    }

    const threadArtifacts = getThreadArtifacts(channel, replyTs);
    if (threadArtifacts.length > 0) {
      const artifactLines = threadArtifacts.map(a =>
        `• artifact:${a.id} — ${a.filename} (${a.mime_type})${a.summary ? ` — "${a.summary}"` : ""}`
      );
      context += `\n\nPreviously created artifacts in this thread (can be referenced by artifactId for re-upload without re-querying):\n${artifactLines.join("\n")}`;
    }

    // inject previous tool call results so follow-ups can reference sources without re-searching
    const previousCalls = getThreadBotCalls(channel, replyTs, 3);
    if (previousCalls.length > 0) {
      const toolSummaries = previousCalls.reverse().map((call) => {
        const toolLines = call.tool_calls
          .filter((tc) => tc.name !== "confidence_check")
          .map((tc) => {
            const output = typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output);
            const truncated = output.length > 500 ? output.slice(0, 500) + "…" : output;
            return `  • ${tc.name}: ${truncated}`;
          });
        return toolLines.length > 0 ? `[response to "${call.prompt.slice(0, 80)}"]\n${toolLines.join("\n")}` : null;
      }).filter(Boolean);
      if (toolSummaries.length > 0) {
        context += `\n\nYour previous tool results in this thread (use these to answer follow-ups about sources — do NOT re-search):\n${toolSummaries.join("\n\n")}`;
      }
    }

    // gate: in active threads (without explicit mention), check if we should respond
    if (isActiveThread && !isMentioned) {
      const gate = await shouldRespond(context, userMessage);
      if (!gate) return;
    }

    const teamId = "team" in message ? (message.team as string | undefined) : undefined;

    // gate: org must be set up before the bot responds
    if (teamId && !getOrgByTeamId(teamId)) {
      await app.client.chat.postEphemeral({
        channel,
        user: message.user as string,
        text: "Organization is not set up yet. Run `/org-setup` first.",
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    const statusThreadTs = threadTs ?? message.ts;
    await app.client.assistant.threads.setStatus({ channel_id: channel, thread_ts: statusThreadTs, status: "is thinking...", loading_messages: ["is thinking..."] });

    const senderName = ALLOWED_USERS[message.user as string];
    const invocationType = isDM ? "dm" : isMentioned ? "mention" : "active_thread";
    const usageLogId = logUsage({
      userId: message.user as string,
      userName: senderName,
      teamId,
      invocationType,
      channelId: channel,
      threadTs: statusThreadTs,
    });
    await enqueueAgentJob({
      prompt: userMessage,
      context: context || undefined,
      slackUserId: message.user as string,
      teamId,
      senderName,
      images: images.length ? images.map((i) => ({ data: i.data.toString("base64"), mimeType: i.mimeType })) : undefined,
      files: files.length ? files.map((f) => ({ data: f.data.toString("base64"), mimeType: f.mimeType, name: f.name })) : undefined,
      channelId: channel,
      threadTs: statusThreadTs,
      replyTs,
      messageTs: message.ts,
      usageLogId,
    });
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
