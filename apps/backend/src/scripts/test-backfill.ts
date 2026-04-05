import { App } from "@slack/bolt";
import { config } from "../config.js";
import { bootstrapOrgAwareness } from "../org/awareness.js";
import { initializeTree } from "../org/propagate.js";
import { ls, cat, countFiles } from "../org/tree.js";

const TEAM_ID = process.env.SLACK_TEAM_ID ?? "T04T4N121MY";

const app = new App({
  token: config.slack.botToken,
  signingSecret: config.slack.signingSecret,
});

async function main() {
  console.log(`\n--- backfill test (team: ${TEAM_ID}) ---\n`);

  initializeTree(TEAM_ID);
  const before = countFiles(TEAM_ID);
  console.log(`Files before: ${before}`);

  const threads = await bootstrapOrgAwareness(app, TEAM_ID);
  const after = countFiles(TEAM_ID);
  console.log(`\nFiles after: ${after} (+${after - before})`);
  console.log(`Threads analyzed: ${threads}`);

  console.log(`\n--- tree ---`);
  console.log(ls(TEAM_ID, ".").join("\n"));

  console.log(`\n--- people/_index.mdx ---`);
  console.log(cat(TEAM_ID, "people/_index.mdx") ?? "(empty)");

  console.log(`\n--- teams/_index.mdx ---`);
  console.log(cat(TEAM_ID, "teams/_index.mdx") ?? "(empty)");

  // show first person file as example
  const people = ls(TEAM_ID, "people");
  const firstPerson = people.find((p) => p !== "_index.mdx");
  if (firstPerson) {
    console.log(`\n--- people/${firstPerson} ---`);
    console.log(cat(TEAM_ID, `people/${firstPerson}`));
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
