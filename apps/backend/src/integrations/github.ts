import { Octokit } from "octokit";
import { config } from "../config.js";

const octokit = new Octokit({ auth: config.github.token });

export async function getRecentPRs(owner: string, repo: string, since?: Date) {
  const { data } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: 30,
  });

  if (since) {
    return data.filter((pr) => new Date(pr.updated_at) >= since);
  }
  return data;
}

export async function getRecentCommits(
  owner: string,
  repo: string,
  since?: Date
) {
  const { data } = await octokit.rest.repos.listCommits({
    owner,
    repo,
    since: since?.toISOString(),
    per_page: 50,
  });
  return data;
}

export async function createPR(
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body?: string,
) {
  const { data } = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    head,
    base,
    body,
  });
  return data;
}

export async function getRepoActivity(owner: string, repo: string) {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [prs, commits] = await Promise.all([
    getRecentPRs(owner, repo, oneWeekAgo),
    getRecentCommits(owner, repo, oneWeekAgo),
  ]);
  return { prs, commits };
}
