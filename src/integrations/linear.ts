import { LinearClient } from "@linear/sdk";
import { config } from "../config.js";

const client = new LinearClient({ apiKey: config.linear.apiKey });

export async function searchIssues(query: string) {
  const results = await client.searchIssues(query);
  return results.nodes.map((issue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    url: issue.url,
  }));
}

export async function getIssue(issueId: string) {
  const issue = await client.issue(issueId);
  const state = await issue.state;
  const assignee = await issue.assignee;
  const team = await issue.team;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    url: issue.url,
    state: state ? { id: state.id, name: state.name } : null,
    assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
    team: team ? { id: team.id, name: team.name, key: team.key } : null,
  };
}

export async function createIssue(
  teamId: string,
  title: string,
  description?: string,
  priority?: number,
  assigneeId?: string,
  labelIds?: string[],
  projectId?: string,
) {
  const result = await client.createIssue({
    teamId,
    title,
    description,
    priority,
    assigneeId,
    labelIds,
    projectId,
  });
  const issue = await result.issue;
  return issue
    ? { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url }
    : null;
}

export async function listLabels(teamId?: string) {
  const labels = await client.issueLabels({ first: 100 });
  const all = labels.nodes.map((l) => ({ id: l.id, name: l.name }));
  if (!teamId) return all;
  // workspace-level labels don't have a team, so include those + team-specific
  const teamLabels = await Promise.all(
    labels.nodes.map(async (l) => {
      const team = await l.team;
      return { id: l.id, name: l.name, teamId: team?.id ?? null };
    }),
  );
  return teamLabels.filter((l) => !l.teamId || l.teamId === teamId);
}

export async function listProjects() {
  const projects = await client.projects({ first: 50 });
  return projects.nodes.map((p) => ({ id: p.id, name: p.name }));
}

export async function attachSlackThread(issueId: string, slackThreadUrl: string) {
  const result = await client.attachmentLinkSlack(issueId, slackThreadUrl);
  return { success: result.success };
}

export async function updateIssue(
  issueId: string,
  fields: { stateId?: string; assigneeId?: string; priority?: number; title?: string; description?: string }
) {
  const result = await client.updateIssue(issueId, fields);
  const issue = await result.issue;
  return issue
    ? { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url }
    : null;
}

export async function listIssues(filters: {
  assigneeName?: string;
  teamId?: string;
  stateId?: string;
  stateName?: string;
  updatedBefore?: string;
  limit?: number;
}) {
  const filter: Record<string, unknown> = {};
  if (filters.assigneeName) filter.assignee = { name: { containsIgnoreCase: filters.assigneeName } };
  if (filters.teamId) filter.team = { id: { eq: filters.teamId } };
  if (filters.stateId) filter.state = { id: { eq: filters.stateId } };
  else if (filters.stateName) filter.state = { name: { containsIgnoreCase: filters.stateName } };
  if (filters.updatedBefore) filter.updatedAt = { lt: new Date(filters.updatedBefore) };

  const results = await client.issues({ filter, first: filters.limit ?? 20 });
  const issues = [];
  for (const issue of results.nodes) {
    const assignee = await issue.assignee;
    const state = await issue.state;
    issues.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      priority: issue.priority,
      url: issue.url,
      assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
      state: state ? { id: state.id, name: state.name } : null,
      slaBreachesAt: issue.slaBreachesAt ?? null,
      slaStartedAt: issue.slaStartedAt ?? null,
      slaType: issue.slaType ?? null,
    });
  }
  return issues;
}

export async function addComment(issueId: string, body: string) {
  const result = await client.createComment({ issueId, body });
  const comment = await result.comment;
  return comment ? { id: comment.id, body: comment.body } : null;
}

export async function listTeams() {
  const teams = await client.teams();
  return teams.nodes.map((team) => ({
    id: team.id,
    name: team.name,
    key: team.key,
  }));
}

export async function getWorkflowStates(teamId: string) {
  const team = await client.team(teamId);
  const states = await team.states();
  return states.nodes.map((state) => ({
    id: state.id,
    name: state.name,
    type: state.type,
  }));
}

export async function listMembers() {
  const users = await client.users();
  return users.nodes.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    active: u.active,
  }));
}

export async function listStaleIssues(staleDays = 15, limit = 50) {
  const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
  const results = await client.issues({
    filter: {
      updatedAt: { lt: cutoff },
      state: { type: { nin: ["completed", "canceled"] } },
    },
    first: limit,
  });

  const issues = [];
  for (const issue of results.nodes) {
    const assignee = await issue.assignee;
    const state = await issue.state;
    issues.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      priority: issue.priority,
      url: issue.url,
      updatedAt: issue.updatedAt,
      assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
      state: state ? { id: state.id, name: state.name } : null,
    });
  }
  return issues;
}
