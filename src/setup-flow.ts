import type { App } from "@slack/bolt";
import { getOrgMemberBySlackId, updateOrgMember } from "./db/org-members.js";
import { getOrgByTeamId } from "./db/orgs.js";
import { setMemberTeams, getTeamByName, updateTeamTools, getOrCreateTeam } from "./db/teams.js";
import { ensureOrgMember } from "./jobs/org-awareness.js";

interface SetupState {
  step: "role" | "reports_to" | "teams" | "team_tools" | "problem_to_solve" | "done";
  teamId: string;
  channelId: string;
  data: {
    role?: string;
    reportsTo?: string;
    teams?: string[];
    currentToolsTeamIdx?: number;
    teamTools?: Record<string, string[]>;
    problemToSolve?: string;
  };
}

const activeSetups = new Map<string, SetupState>();

export function getActiveSetup(userId: string): SetupState | undefined {
  return activeSetups.get(userId);
}

export function startSetup(userId: string, teamId: string, channelId: string): SetupState {
  const state: SetupState = {
    step: "role",
    teamId,
    channelId,
    data: {},
  };
  activeSetups.set(userId, state);
  return state;
}

export function clearSetup(userId: string): void {
  activeSetups.delete(userId);
}

function parseSlackMention(text: string): string | null {
  const match = text.match(/<@(U[A-Z0-9]+)>/);
  return match ? match[1] : null;
}

export async function handleSetupReply(app: App, userId: string, text: string): Promise<void> {
  const state = activeSetups.get(userId);
  if (!state) return;

  const say = (msg: string) =>
    app.client.chat.postMessage({ channel: state.channelId, text: msg });

  const trimmed = text.trim();

  switch (state.step) {
    case "role": {
      state.data.role = trimmed;
      state.step = "reports_to";
      await say("Who do you report to? Mention them (e.g. `@someone`) or type \"none\".");
      break;
    }

    case "reports_to": {
      if (trimmed.toLowerCase() === "none") {
        state.data.reportsTo = undefined;
      } else {
        const mention = parseSlackMention(trimmed);
        state.data.reportsTo = mention ?? trimmed;
      }
      state.step = "teams";
      await say("What team(s) are you part of? (comma-separated, e.g. \"AI, Engineering\")");
      break;
    }

    case "teams": {
      const teams = trimmed.split(",").map((t) => t.trim()).filter(Boolean);
      state.data.teams = teams;
      if (teams.length > 0) {
        state.data.teamTools = {};
        state.data.currentToolsTeamIdx = 0;
        state.step = "team_tools";
        await say(`What tools does *${teams[0]}* use day-to-day? (comma-separated, e.g. "Linear, GitHub, Figma")`);
      } else {
        state.step = "problem_to_solve";
        await say("Last one — what's the *#1 measurable problem* you're trying to solve? Think high-level.\ne.g. \"bring clients to 90% automation rate\", \"reach 10M€ ARR by EOY\"");
      }
      break;
    }

    case "team_tools": {
      const teams = state.data.teams!;
      const idx = state.data.currentToolsTeamIdx!;
      const tools = trimmed.split(",").map((t) => t.trim()).filter(Boolean);
      state.data.teamTools![teams[idx]] = tools;

      const nextIdx = idx + 1;
      if (nextIdx < teams.length) {
        state.data.currentToolsTeamIdx = nextIdx;
        await say(`What tools does *${teams[nextIdx]}* use day-to-day?`);
      } else {
        state.step = "problem_to_solve";
        await say("Last one — what's the *#1 measurable problem* you're trying to solve? Think high-level.\ne.g. \"bring clients to 90% automation rate\", \"reach 10M€ ARR by EOY\"");
      }
      break;
    }

    case "problem_to_solve": {
      state.data.problemToSolve = trimmed;
      state.step = "done";

      // persist everything
      await persistSetupData(app, userId, state);

      // build summary
      const lines = ["Setup complete! Here's what I saved:"];
      if (state.data.role) lines.push(`• *Role:* ${state.data.role}`);
      if (state.data.reportsTo) lines.push(`• *Reports to:* <@${state.data.reportsTo}>`);
      if (state.data.teams?.length) {
        for (const team of state.data.teams) {
          const tools = state.data.teamTools?.[team];
          lines.push(`• *Team:* ${team}${tools?.length ? ` (tools: ${tools.join(", ")})` : ""}`);
        }
      }
      if (state.data.problemToSolve) lines.push(`• *Problem to solve:* ${state.data.problemToSolve}`);

      await say(lines.join("\n"));
      clearSetup(userId);
      break;
    }
  }
}

async function persistSetupData(app: App, userId: string, state: SetupState): Promise<void> {
  // ensure member exists
  await ensureOrgMember(app, userId, state.teamId);

  const overrides: Record<string, boolean> = {};
  const fields: Parameters<typeof updateOrgMember>[1] = {};

  if (state.data.role) {
    fields.role = state.data.role;
    overrides.role = true;
  }
  if (state.data.reportsTo) {
    fields.reportsTo = state.data.reportsTo;
    overrides.reports_to = true;
  }
  if (state.data.problemToSolve) {
    fields.problemToSolve = state.data.problemToSolve;
    overrides.problem_to_solve = true;
  }
  if (state.data.teams?.length) {
    overrides.teams = true;
  }

  fields.userOverrides = JSON.stringify(overrides);
  updateOrgMember(userId, fields);

  // set team memberships + tools
  const org = getOrgByTeamId(state.teamId);
  if (org && state.data.teams?.length) {
    const member = getOrgMemberBySlackId(userId);
    if (member) {
      setMemberTeams(member.id, org.id, state.data.teams);
      for (const [teamName, tools] of Object.entries(state.data.teamTools ?? {})) {
        const team = getTeamByName(org.id, teamName);
        if (team && tools.length > 0) {
          updateTeamTools(team.id, tools);
        }
      }
    }
  }
}
