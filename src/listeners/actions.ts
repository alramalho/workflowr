import type { App } from "@slack/bolt";
import * as sm from "../integrations/supermemory.js";

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
