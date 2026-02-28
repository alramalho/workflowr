import type { App } from "@slack/bolt";
import { getRepoActivity } from "../integrations/github.js";
import { postMessage } from "../integrations/slack.js";

interface RepoConfig {
  owner: string;
  repo: string;
}

export async function sendWeeklyReport(
  app: App,
  channel: string,
  repos: RepoConfig[]
) {
  const sections: string[] = ["*Weekly AI Team Report*\n"];

  for (const { owner, repo } of repos) {
    const { prs, commits } = await getRepoActivity(owner, repo);

    const mergedPRs = prs.filter((pr) => pr.merged_at);
    const openPRs = prs.filter((pr) => pr.state === "open");

    sections.push(`*${owner}/${repo}*`);
    sections.push(`  Commits: ${commits.length}`);
    sections.push(`  PRs merged: ${mergedPRs.length}`);
    sections.push(`  PRs open: ${openPRs.length}`);

    if (mergedPRs.length > 0) {
      sections.push("  _Merged:_");
      for (const pr of mergedPRs.slice(0, 10)) {
        sections.push(`  • <${pr.html_url}|${pr.title}> by ${pr.user?.login}`);
      }
    }
    sections.push("");
  }

  await postMessage(app, channel, sections.join("\n"));
}
