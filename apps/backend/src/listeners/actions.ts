import type { App } from "@slack/bolt";
import * as sm from "../integrations/supermemory.js";
import { translateThread, translateMessage } from "../integrations/translate.js";
import { runAgent } from "../agent/index.js";
import { getThreadReplies } from "../integrations/slack.js";
import { ALLOWED_USERS, ADMIN_USERS } from "./events.js";
import { textToBlocksWithTable } from "../slack-table.js";
import { getOrgByTeamId, createOrg, updateOrg, deleteOrg } from "../db/orgs.js";
import { enrichOrgFromUrl, bootstrapOrgAwareness, editOrgFromInstruction } from "../org/awareness.js";
import { cat } from "../org/tree.js";
import {
  getUserTasks,
  getTaskSteps,
  getTask,
  createTask,
  updateTask,
  updateTaskStep,
  deleteTask,
  type Task,
  type TaskStep,
} from "../db/tasks.js";
import { saveBotCall, getBotCallByMessageTs } from "../db/bot-calls.js";
import { logUsage } from "../db/usage-log.js";
import { upsertSkill } from "../db/skills.js";
import { upsertSecret } from "../db/secrets.js";
import { parseSkillDescription } from "../agent/skills-parser.js";
import { isRunnerConnected, getConnectedRunnerDirectories } from "../runner/server.js";
import { getRunnerForUser } from "../db/runners.js";

// In-memory history for ask_workflowr so consecutive asks on the same thread retain context
const askHistory = new Map<string, { role: "user" | "assistant"; text: string }[]>();

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
    text: { type: "mrkdwn", text: "*Org Memories*" },
  });

  if (orgMemories.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No org memories yet._" },
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

const STATUS_EMOJI: Record<string, string> = {
  active: ":large_green_circle:",
  paused: ":double_vertical_bar:",
  completed: ":white_check_mark:",
  pending_confirmation: ":hourglass:",
  failed: ":x:",
};

const STEP_TYPE_LABEL: Record<string, string> = {
  cron: ":repeat: cron",
  trigger: ":zap: trigger",
  action: ":arrow_forward: action",
  check: ":mag: check",
};

function buildStepTree(steps: TaskStep[]): { step: TaskStep; children: TaskStep[] }[] {
  const topLevel = steps.filter((s) => !s.parent_step_id);
  return topLevel.map((s) => ({
    step: s,
    children: steps.filter((c) => c.parent_step_id === s.id),
  }));
}

export function buildTaskBlocks(userId: string, teamId?: string): any[] {
  const tasks = getUserTasks(userId, teamId);
  const blocks: any[] = [];

  // Runner status
  if (teamId) {
    const connected = isRunnerConnected(userId, teamId);
    const dirs = connected ? getConnectedRunnerDirectories(userId, teamId) : [];
    const runner = getRunnerForUser(userId, teamId);

    if (connected && dirs.length > 0) {
      const dirList = dirs.map((d) => `\`${d.name}\`${d.description ? ` — ${d.description}` : ""}`).join(", ");
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `:large_green_circle: *Runner connected* — workspaces: ${dirList}` },
      });
    } else if (runner) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `:white_circle: *Runner disconnected* — run the install command again or check your machine` },
      });
    } else {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `:white_circle: *No runner set up* — use \`/setup-daemon\` to connect your codebase` },
      });
    }
    blocks.push({ type: "divider" });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*Your Tasks*" },
  });

  if (tasks.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No tasks yet. Use `/create-task` to set one up!_" },
    });
    return blocks;
  }

  for (const task of tasks) {
    const emoji = STATUS_EMOJI[task.status] ?? ":grey_question:";
    const steps = getTaskSteps(task.id);
    const tree = buildStepTree(steps);

    const stepLines: string[] = [];
    for (const { step, children } of tree) {
      const sEmoji = STATUS_EMOJI[step.status] ?? "";
      const typeLabel = STEP_TYPE_LABEL[step.type] ?? step.type;
      const schedule = step.schedule ? ` \`${step.schedule}\`` : "";
      stepLines.push(`  ${sEmoji} ${typeLabel}${schedule} — ${step.title}`);
      for (const child of children) {
        const cEmoji = STATUS_EMOJI[child.status] ?? "";
        const cType = STEP_TYPE_LABEL[child.type] ?? child.type;
        const cSchedule = child.schedule ? ` \`${child.schedule}\`` : "";
        stepLines.push(`    ${cEmoji} ${cType}${cSchedule} — ${child.title}`);
      }
    }

    const desc = task.description ? `\n> ${task.description}` : "";
    const stepsText = stepLines.length > 0 ? `\n${stepLines.join("\n")}` : "\n  _No steps yet_";

    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *${task.title}*${desc}${stepsText}`,
      },
    });

    const hasRecurringSteps = steps.some((s) => (s.type === "cron" || s.type === "trigger") && s.status === "active");
    const actions: any[] = [];
    if (task.status === "active" && hasRecurringSteps) {
      actions.push({
        type: "button",
        text: { type: "plain_text", text: "Trigger" },
        action_id: `task_trigger_${task.id}`,
      });
    }
    if (task.status === "active") {
      actions.push({
        type: "button",
        text: { type: "plain_text", text: "Pause" },
        action_id: `task_pause_${task.id}`,
      });
    } else if (task.status === "paused") {
      actions.push({
        type: "button",
        text: { type: "plain_text", text: "Resume" },
        action_id: `task_resume_${task.id}`,
      });
    }
    if (task.status !== "completed" && !hasRecurringSteps) {
      actions.push({
        type: "button",
        text: { type: "plain_text", text: "Complete" },
        action_id: `task_complete_${task.id}`,
      });
    }
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "Delete" },
      action_id: `task_delete_${task.id}`,
      style: "danger",
      confirm: {
        title: { type: "plain_text", text: "Delete task?" },
        text: { type: "plain_text", text: "This will permanently delete this task and all its steps." },
        confirm: { type: "plain_text", text: "Delete" },
        deny: { type: "plain_text", text: "Cancel" },
      },
    });

    if (actions.length > 0) {
      blocks.push({ type: "actions", elements: actions });
    }
  }

  return blocks;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

export function registerActions(app: App) {
  // message shortcut: Inspect bot response
  app.shortcut("inspect", async ({ shortcut, ack, client }) => {
    await ack();
    if (shortcut.type !== "message_action") return;

    const { channel, message, user } = shortcut;

    if (!(user.id in ADMIN_USERS)) {
      await client.chat.postEphemeral({
        channel: channel.id,
        user: user.id,
        thread_ts: (message as any).thread_ts ?? message.ts,
        text: "You're not authorized to use this. Ask <@U08PH00GP9Q> if you want access.",
      });
      return;
    }

    const call = getBotCallByMessageTs(channel.id, message.ts);

    if (!call) {
      await client.chat.postEphemeral({
        channel: channel.id,
        user: user.id,
        thread_ts: (message as any).thread_ts ?? message.ts,
        text: "No agent call found for this message.",
      });
      return;
    }

    const callerName = ALLOWED_USERS[call.caller_id] ?? call.caller_id;
    const latencySec = (call.latency_ms / 1000).toFixed(1);

    const blocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Inspect Agent Call*\n• *Caller:* ${callerName}\n• *Latency:* ${latencySec}s\n• *Tool calls:* ${call.tool_calls.length}\n• *Time:* ${call.created_at}`,
        },
      },
    ];

    if (call.tool_calls.length > 0) {
      blocks.push({ type: "divider" });
      for (const tc of call.tool_calls) {
        const inputStr = truncate(JSON.stringify(tc.input, null, 2), 2500);
        const output = tc.output as any;
        const hasInternals = output && typeof output === "object" && Array.isArray(output.internals) && output.internals.length > 0;
        const displayOutput = hasInternals ? output.answer ?? output : tc.output;
        const outputStr = truncate(typeof displayOutput === "string" ? displayOutput : JSON.stringify(displayOutput, null, 2), 2500);

        let internalsStr = "";
        if (hasInternals) {
          const lines = output.internals.map((i: any) => {
            const args = typeof i.args === "string" ? i.args : JSON.stringify(i.args);
            return `  ${i.tool}(${truncate(args, 200)})`;
          });
          internalsStr = `\n_Internals (${output.internals.length} sub-calls):_\n\`\`\`${lines.join("\n")}\`\`\``;
        }

        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${tc.name}*\n\`\`\`${inputStr}\`\`\`\n_Output:_\n\`\`\`${outputStr}\`\`\`${internalsStr}`,
          },
        });
      }
    }

    await client.chat.postEphemeral({
      channel: channel.id,
      user: user.id,
      thread_ts: (message as any).thread_ts ?? message.ts,
      blocks,
      text: `Inspect: ${call.tool_calls.length} tool call(s), ${latencySec}s latency`,
    });
  });

  // message shortcut: Translate message or thread
  app.shortcut("translate_thread", async ({ shortcut, ack, client }) => {
    await ack();

    if (shortcut.type !== "message_action") return;

    const { channel, message, user } = shortcut;
    logUsage({
      userId: user.id,
      userName: ALLOWED_USERS[user.id],
      teamId: shortcut.team?.id,
      invocationType: "shortcut:translate_thread",
      channelId: channel.id,
      threadTs: (message as any).thread_ts ?? message.ts,
    });
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

    logUsage({
      userId,
      userName: senderName,
      teamId,
      invocationType: "shortcut:ask_workflowr",
      channelId: channel_id,
      threadTs: thread_ts,
    });

    await client.chat.postEphemeral({
      channel: channel_id,
      user: userId,
      thread_ts,
      text: `> ${instruction}\n\n_thinking..._`,
    });

    try {
      let context = "";
      const replies = await getThreadReplies(app, channel_id, thread_ts);
      if (replies.length > 0) {
        const label = (m: any) => {
          if (m.bot_id || m.bot_profile) return `[app: ${(m.bot_profile as any)?.name ?? m.username ?? "unknown bot"}]`;
          return `<@${m.user}>`;
        };
        context = `Thread context:\n${replies.map((m) => `${label(m)}: ${m.text}`).join("\n")}`;
      }

      // Include prior ask_workflowr exchanges on this thread
      const historyKey = `${channel_id}:${thread_ts}`;
      const priorExchanges = askHistory.get(historyKey) ?? [];
      if (priorExchanges.length > 0) {
        const exchangeText = priorExchanges
          .map((e) => `${e.role === "user" ? "User asked" : "Workflowr answered"}: ${e.text}`)
          .join("\n");
        context = context
          ? `${context}\n\nPrevious ask-workflowr exchanges on this thread:\n${exchangeText}`
          : `Previous ask-workflowr exchanges on this thread:\n${exchangeText}`;
      }

      const result = await runAgent(
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

      // Store this exchange in history
      priorExchanges.push({ role: "user", text: instruction });
      priorExchanges.push({ role: "assistant", text: result.text || "" });
      askHistory.set(historyKey, priorExchanges);

      saveBotCall({
        callerId: userId,
        channelId: channel_id,
        threadTs: thread_ts,
        prompt: instruction,
        response: result.text,
        toolCalls: result.toolCalls,
        latencyMs: result.latencyMs,
      });

      await client.chat.postEphemeral({
        channel: channel_id,
        user: userId,
        thread_ts,
        text: result.text || "I couldn't generate a response.",
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

  // handle setup-org modal submission
  app.view("setup_org_modal", async ({ ack, view, body, client }) => {
    await ack();

    const url = view.state.values.org_url_block.org_url.value?.trim() ?? "";
    const teamId = body.team?.id;
    const teamDomain = (body.team as any)?.domain as string | undefined;
    const userId = body.user.id;

    if (!url || !teamId) return;

    try {
      await client.chat.postMessage({
        channel: userId,
        text: `Looking up _${url}_... this may take a moment.`,
      });

      const info = await enrichOrgFromUrl(url);

      const existing = getOrgByTeamId(teamId);
      if (existing) {
        updateOrg(existing.id, {
          name: info.name,
          url,
          description: info.description,
          industry: info.industry,
          location: info.location,
          slackDomain: teamDomain,
        });
      } else {
        createOrg(info.name, {
          teamId,
          url,
          description: info.description,
          industry: info.industry,
          location: info.location,
          slackDomain: teamDomain,
        });
      }

      await client.chat.postMessage({
        channel: userId,
        text: [
          `Organization set up:`,
          `*${info.name}*`,
          info.description ? `> ${info.description}` : null,
          info.industry ? `Industry: ${info.industry}` : null,
          info.location ? `Location: ${info.location}` : null,
          "",
          "_Bootstrapping org awareness from recent threads... this runs in the background._",
        ].filter(Boolean).join("\n"),
      });

      // bootstrap org awareness in the background
      bootstrapOrgAwareness(app, teamId).then((count) => {
        const peopleIndex = cat(teamId, "people/_index.mdx") ?? "";
        const teamsIndex = cat(teamId, "teams/_index.mdx") ?? "";
        client.chat.postMessage({
          channel: userId,
          text: `Org awareness bootstrap complete — analyzed ${count} threads.\n\n${teamsIndex}\n\n${peopleIndex}`,
        });
      }).catch((e) => {
        console.error("Bootstrap error:", e);
        client.chat.postMessage({
          channel: userId,
          text: "Org awareness bootstrap failed. Profiles will build up organically from thread activity.",
        });
      });
    } catch (error) {
      console.error("Setup org error:", error);
      await client.chat.postMessage({
        channel: userId,
        text: "Something went wrong setting up the organization. Please try again.",
      });
    }
  });

  // handle create-task modal submission
  app.view("create_task_modal", async ({ ack, view, body, client }) => {
    await ack();

    const goal = view.state.values.task_goal_block.task_goal.value?.trim() ?? "";
    const { team_id: teamId } = JSON.parse(view.private_metadata);
    const userId = body.user.id;
    const senderName = ALLOWED_USERS[userId];

    if (!goal) return;

    const task = createTask(userId, goal, { teamId });

    // DM the user and kick off the breakdown conversation
    const dm = await client.chat.postMessage({
      channel: userId,
      text: `*New task created:* ${goal}\n\n_Let me figure out how to break this down for you..._`,
    });

    const threadTs = dm.ts;

    try {
      const prompt = `The user just created a new task via /create-task. The task has been saved (task #${task.id}).

Their goal: "${goal}"

Your job now is to break this task down into actionable steps. Ask the user clarifying questions to understand:
1. What tools/integrations are needed (Linear, Slack, GitHub, Google Calendar)?
2. What's the cadence — is this recurring (cron) or one-off?
3. Where does the information come from and where should results go?
4. Any specific conditions or thresholds?

Be conversational and specific. Propose concrete steps once you have enough info. Do NOT create steps yet — first get confirmation from the user on the breakdown. Keep it concise.`;

      const result = await runAgent(app, prompt, undefined, userId, teamId, senderName, undefined, userId, threadTs);

      const breakdownText = result.text || "Let's figure this out — what tools and cadence does this involve?";
      const tableResult = textToBlocksWithTable(breakdownText);
      await client.chat.postMessage({
        channel: userId,
        text: breakdownText,
        thread_ts: threadTs,
        ...(tableResult && { blocks: tableResult.blocks }),
      });
    } catch (error) {
      console.error("Task breakdown error:", error);
      await client.chat.postMessage({
        channel: userId,
        text: "Something went wrong starting the breakdown. DM me directly to continue setting up this task.",
        thread_ts: threadTs,
      });
    }
  });

  // edit org setup — free-text instruction to update org info
  app.action("setup_org_edit", async ({ ack, body, client }) => {
    await ack();
    if (!("trigger_id" in body)) return;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "edit_org_modal",
        title: { type: "plain_text", text: "Edit Organization" },
        submit: { type: "plain_text", text: "Update" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "edit_instruction_block",
            label: { type: "plain_text", text: "What do you want to change?" },
            element: {
              type: "plain_text_input",
              action_id: "edit_instruction",
              multiline: true,
              placeholder: { type: "plain_text", text: "e.g. We moved to Berlin, our industry is actually fintech" },
            },
          },
        ],
      },
    });
  });

  // handle edit org modal submission
  app.view("edit_org_modal", async ({ ack, view, body, client }) => {
    await ack();

    const instruction = view.state.values.edit_instruction_block.edit_instruction.value?.trim() ?? "";
    const teamId = body.team?.id;
    const userId = body.user.id;

    if (!instruction || !teamId) return;

    const existing = getOrgByTeamId(teamId);
    if (!existing) return;

    try {
      const updated = await editOrgFromInstruction(existing, instruction);

      updateOrg(existing.id, {
        name: updated.name,
        description: updated.description,
        industry: updated.industry,
        location: updated.location,
      });

      await client.chat.postMessage({
        channel: userId,
        text: [
          `Organization updated:`,
          `*${updated.name}*`,
          updated.description ? `> ${updated.description}` : null,
          updated.industry ? `Industry: ${updated.industry}` : null,
          updated.location ? `Location: ${updated.location}` : null,
        ].filter(Boolean).join("\n"),
      });
    } catch (error) {
      console.error("Edit org error:", error);
      await client.chat.postMessage({
        channel: userId,
        text: "Something went wrong updating the organization.",
      });
    }
  });

  // delete org setup
  app.action("setup_org_delete", async ({ ack, body, respond }) => {
    await ack();
    const teamId = body.team?.id;
    if (!teamId) return;

    const existing = getOrgByTeamId(teamId);
    if (existing) {
      deleteOrg(existing.id);
    }

    await respond({
      text: "Organization setup deleted. Run `/org-setup` to set it up again.",
      replace_original: true,
      response_type: "ephemeral",
    });
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
                  text: { type: "plain_text", text: "Org" },
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

  // task actions: pause, resume, complete, delete
  app.action(/^task_trigger_\d+$/, async ({ action, ack, respond }) => {
    await ack();
    const taskId = parseInt((action as any).action_id.replace("task_trigger_", ""));
    const steps = getTaskSteps(taskId);
    const cronSteps = steps.filter((s) => s.type === "cron" && s.status === "active");
    if (cronSteps.length === 0) {
      await respond({ text: `No active cron steps to trigger.`, replace_original: false, response_type: "ephemeral" });
      return;
    }
    for (const step of cronSteps) {
      const { scheduleDelayedJob } = await import("../queues/delayed-jobs-queue.js");
      scheduleDelayedJob("task_step_execute", `task_step_${step.id}_manual_${Date.now()}`, { stepId: step.id }, new Date());
    }
    await respond({ text: `Triggered ${cronSteps.length} step(s) for task #${taskId}. Results will be sent shortly.`, replace_original: false, response_type: "ephemeral" });
  });

  app.action(/^task_pause_\d+$/, async ({ action, ack, respond }) => {
    await ack();
    const taskId = parseInt((action as any).action_id.replace("task_pause_", ""));
    updateTask(taskId, { status: "paused" });
    await respond({ text: `Task #${taskId} paused.`, replace_original: false, response_type: "ephemeral" });
  });

  app.action(/^task_resume_\d+$/, async ({ action, ack, respond }) => {
    await ack();
    const taskId = parseInt((action as any).action_id.replace("task_resume_", ""));
    updateTask(taskId, { status: "active" });
    await respond({ text: `Task #${taskId} resumed.`, replace_original: false, response_type: "ephemeral" });
  });

  app.action(/^task_complete_\d+$/, async ({ action, ack, respond }) => {
    await ack();
    const taskId = parseInt((action as any).action_id.replace("task_complete_", ""));
    updateTask(taskId, { status: "completed" });
    await respond({ text: `Task #${taskId} completed.`, replace_original: false, response_type: "ephemeral" });
  });

  app.action(/^task_delete_\d+$/, async ({ action, ack, respond }) => {
    await ack();
    const taskId = parseInt((action as any).action_id.replace("task_delete_", ""));
    deleteTask(taskId);
    await respond({ text: `Task #${taskId} deleted.`, replace_original: false, response_type: "ephemeral" });
  });

  app.action("skill_confirm", async ({ action, ack, respond }) => {
    await ack();
    try {
      const payload = JSON.parse((action as any).value);
      const { teamId, userId, skill } = payload;

      upsertSkill(teamId, skill.name, skill.description, skill.content, userId);

      await respond({
        text: `Skill \`${skill.name}\` created! It's now available for me to use.`,
        replace_original: true,
        response_type: "ephemeral",
      });
    } catch (error) {
      console.error("Skill confirm error:", error);
      await respond({
        text: "Something went wrong creating the skill.",
        replace_original: true,
        response_type: "ephemeral",
      });
    }
  });

  app.action("skill_correct", async ({ action, ack, body, client }) => {
    await ack();
    const payload = (action as any).value;
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: "modal",
        callback_id: "skill_correct_modal",
        private_metadata: payload,
        title: { type: "plain_text", text: "Correct skill" },
        submit: { type: "plain_text", text: "Re-parse" },
        blocks: [
          {
            type: "input",
            block_id: "correction_block",
            label: { type: "plain_text", text: "What should be different?" },
            element: {
              type: "plain_text_input",
              action_id: "correction_input",
              multiline: true,
              placeholder: { type: "plain_text", text: "e.g. the trigger should be keyword-based, not on every message" },
            },
          },
        ],
      },
    });
  });

  app.action("skill_cancel", async ({ ack, respond }) => {
    await ack();
    await respond({
      text: "Skill creation rejected.",
      replace_original: true,
      response_type: "ephemeral",
    });
  });

  app.view("skill_correct_modal", async ({ ack, view, body, client }) => {
    await ack();
    const correction = view.state.values.correction_block.correction_input.value?.trim();
    if (!correction) return;

    const payload = JSON.parse(view.private_metadata);
    const userId = body.user.id;

    try {
      await client.chat.postMessage({
        channel: userId,
        text: ":hourglass_flowing_sand: Re-parsing with your corrections...",
      });

      const parsed = await parseSkillDescription(
        payload.skill.description ?? payload.skill.content,
        { previous: payload.skill, feedback: correction },
      );

      const previewLines = [
        `*Skill Preview (corrected)*`,
        "",
        `*Name:* \`${parsed.name}\``,
        `*Description:* ${parsed.description}`,
        `*Content:*`,
        parsed.content,
      ];

      const newPayload = JSON.stringify({
        teamId: payload.teamId,
        userId: payload.userId,
        skill: parsed,
      });

      await client.chat.postMessage({
        channel: userId,
        text: previewLines.join("\n"),
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: previewLines.join("\n") },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Create" },
                action_id: "skill_confirm",
                style: "primary",
                value: newPayload,
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Correct" },
                action_id: "skill_correct",
                value: newPayload,
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Reject" },
                action_id: "skill_cancel",
                style: "danger",
              },
            ],
          },
        ],
      });
    } catch (error) {
      console.error("Skill correction error:", error);
      await client.chat.postMessage({
        channel: userId,
        text: "Something went wrong re-parsing the skill. Try again.",
      });
    }
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
