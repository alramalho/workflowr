import type { App } from "@slack/bolt";
import * as sm from "../integrations/supermemory.js";
import { translateThread, translateMessage } from "../integrations/translate.js";
import { runAgent } from "../agent/index.js";
import { getThreadReplies } from "../integrations/slack.js";
import { ALLOWED_USERS } from "./events.js";

interface Memory {
  id: string;
  title: string | null;
  content?: string | null;
  summary?: string | null;
  createdAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildMemoryBlocks(
  userMemories: Memory[],
  orgMemories: Memory[],
) {
  const blocks: any[] = [];

  // header + add button
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*Your Memories*" },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "Add Memory" },
      action_id: "memory_add_open",
    },
  });

  if (userMemories.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No personal memories yet._" },
    });
  } else {
    for (const m of userMemories.slice(0, 15)) {
      const label = m.content?.slice(0, 120) ?? m.title ?? m.summary ?? "(empty)";
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `• ${label}` },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Delete" },
          action_id: `memory_delete_${m.id}`,
          style: "danger",
          confirm: {
            title: { type: "plain_text", text: "Delete memory?" },
            text: { type: "plain_text", text: "This can't be undone." },
            confirm: { type: "plain_text", text: "Delete" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
      });
    }
  }

  blocks.push({ type: "divider" });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*Team Memories*" },
  });

  if (orgMemories.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No team memories yet._" },
    });
  } else {
    for (const m of orgMemories.slice(0, 15)) {
      const label = m.content?.slice(0, 120) ?? m.title ?? m.summary ?? "(empty)";
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `• ${label}` },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Delete" },
          action_id: `memory_delete_${m.id}`,
          style: "danger",
          confirm: {
            title: { type: "plain_text", text: "Delete memory?" },
            text: { type: "plain_text", text: "This can't be undone." },
            confirm: { type: "plain_text", text: "Delete" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
      });
    }
  }

  return blocks;
}

export function registerActions(app: App) {
  // message shortcut: Translate message or thread
  app.shortcut("translate_thread", async ({ shortcut, ack, client }) => {
    await ack();

    if (shortcut.type !== "message_action") return;

    const { channel, message, user } = shortcut;
    const teamDomain = shortcut.team?.domain ?? "slack";
    const threadTs = (message as any).thread_ts;
    const isReply = threadTs && threadTs !== message.ts;

    // always reply inside a thread
    const replyTs = threadTs ?? message.ts;

    try {
      await client.chat.postEphemeral({
        channel: channel.id,
        user: user.id,
        thread_ts: replyTs,
        text: "_⏳ translating..._",
      });
    } catch {
      // channel not accessible — fall through, DM will handle errors below
    }

    try {
      const msgFiles = (message as any).files as any[] | undefined;
      const msgText = (message as any).text ?? "";

      const result = isReply
        ? await translateMessage(app, channel.id, message.ts, msgText, (message as any).user, teamDomain, msgFiles)
        : await translateThread(app, channel.id, message.ts, teamDomain, user.id);

      await client.chat.postEphemeral({
        channel: channel.id,
        user: user.id,
        thread_ts: replyTs,
        text: result,
      });
    } catch (error) {
      console.error("Translate shortcut error:", error);
      const reason = error instanceof Error ? error.message : String(error);
      await client.chat.postMessage({
        channel: user.id,
        text: `Translation failed: ${reason}`,
      }).catch(() => {});
    }
  });

  // message shortcut: Ask Workflowr (ephemeral, with thread context)
  app.shortcut("ask_workflowr", async ({ shortcut, ack, client }) => {
    await ack();
    if (shortcut.type !== "message_action") return;

    const { channel, message } = shortcut;
    const threadTs = (message as any).thread_ts ?? message.ts;

    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: {
        type: "modal",
        callback_id: "ask_workflowr_modal",
        private_metadata: JSON.stringify({
          channel_id: channel.id,
          thread_ts: threadTs,
        }),
        title: { type: "plain_text", text: "Ask Workflowr" },
        submit: { type: "plain_text", text: "Ask" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "instruction_block",
            label: { type: "plain_text", text: "What do you want?" },
            element: {
              type: "plain_text_input",
              action_id: "instruction",
              multiline: true,
              placeholder: { type: "plain_text", text: "e.g. summarize this thread" },
            },
          },
        ],
      },
    });
  });

  // handle ask_workflowr modal submission
  app.view("ask_workflowr_modal", async ({ ack, view, body, client }) => {
    await ack();

    const instruction = view.state.values.instruction_block.instruction.value ?? "";
    const { channel_id, thread_ts } = JSON.parse(view.private_metadata);
    const userId = body.user.id;
    const teamId = body.team?.id;
    const senderName = ALLOWED_USERS[userId];

    if (!(userId in ALLOWED_USERS)) {
      await client.chat.postEphemeral({
        channel: channel_id,
        user: userId,
        thread_ts,
        text: "You're not allowed to use this. Talk to <@U08PH00GP9Q> if you want access.",
      });
      return;
    }

    await client.chat.postEphemeral({
      channel: channel_id,
      user: userId,
      thread_ts,
      text: "_thinking..._",
    });

    try {
      let context = "";
      const replies = await getThreadReplies(app, channel_id, thread_ts);
      if (replies.length > 0) {
        context = `Thread context:\n${replies.map((m) => `<@${m.user}>: ${m.text}`).join("\n")}`;
      }

      const response = await runAgent(
        app,
        instruction,
        context || undefined,
        userId,
        teamId,
        senderName,
        undefined,
        channel_id,
        thread_ts,
      );

      await client.chat.postEphemeral({
        channel: channel_id,
        user: userId,
        thread_ts,
        text: response || "I couldn't generate a response.",
      });
    } catch (error) {
      console.error("Ask Workflowr error:", error);
      await client.chat.postEphemeral({
        channel: channel_id,
        user: userId,
        thread_ts,
        text: "Something went wrong while processing your request.",
      });
    }
  });

  // delete a memory
  app.action(/^memory_delete_.+/, async ({ action, ack, respond }) => {
    await ack();
    const memoryId = (action as any).action_id?.replace("memory_delete_", "");
    if (!memoryId) return;
    try {
      await sm.deleteMemory(memoryId);
      await respond({ text: "Memory deleted.", replace_original: false, response_type: "ephemeral" });
    } catch (error) {
      console.error("Memory delete error:", error);
      await respond({ text: "Failed to delete memory.", replace_original: false, response_type: "ephemeral" });
    }
  });

  // open add-memory modal
  app.action("memory_add_open", async ({ ack, body, client }) => {
    await ack();
    if (!("trigger_id" in body)) return;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "memory_add_modal",
        title: { type: "plain_text", text: "Add Memory" },
        submit: { type: "plain_text", text: "Save" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "memory_content_block",
            label: { type: "plain_text", text: "Memory" },
            element: {
              type: "plain_text_input",
              action_id: "memory_content",
              multiline: true,
              placeholder: { type: "plain_text", text: "e.g. I prefer bullet-point summaries" },
            },
          },
          {
            type: "input",
            block_id: "memory_scope_block",
            label: { type: "plain_text", text: "Scope" },
            element: {
              type: "static_select",
              action_id: "memory_scope",
              options: [
                {
                  text: { type: "plain_text", text: "Personal" },
                  value: "user",
                },
                {
                  text: { type: "plain_text", text: "Team" },
                  value: "org",
                },
              ],
              initial_option: {
                text: { type: "plain_text", text: "Personal" },
                value: "user",
              },
            },
          },
        ],
      },
    });
  });

  // handle modal submission
  app.view("memory_add_modal", async ({ ack, view, body }) => {
    await ack();

    const content =
      view.state.values.memory_content_block.memory_content.value ?? "";
    const scope =
      (view.state.values.memory_scope_block.memory_scope.selected_option
        ?.value as "user" | "org") ?? "user";

    const userId = body.user.id;
    const teamId = body.team?.id;

    const tag =
      scope === "org" && teamId
        ? sm.orgTag(teamId)
        : sm.userTag(userId);

    try {
      await sm.addMemory(content, tag);
    } catch (error) {
      console.error("Memory add error:", error);
    }
  });
}
