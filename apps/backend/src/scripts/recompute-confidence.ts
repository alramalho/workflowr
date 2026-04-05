import { allFilesInDir, writeFile } from "../org/tree.js";

const TEAM_ID = process.env.SLACK_TEAM_ID ?? "T04T4N121MY";

const dirs = ["people", "people/external"];
let updated = 0;

for (const dir of dirs) {
  const files = allFilesInDir(TEAM_ID, dir).filter((f) => f.name !== "_index.mdx");
  for (const f of files) {
    const fm = f.frontmatter;
    const hasRole = !!fm.role && fm.role !== "unknown";
    const hasTeam = !!(fm.teams as string[] | undefined)?.length;
    const hasWritingStyle = !!fm.writing_style;
    const confidence = hasRole && hasTeam ? (hasWritingStyle ? "high" : "medium") : "low";

    if (fm.confidence !== confidence) {
      fm.confidence = confidence;
      writeFile(TEAM_ID, f.path, fm, f.content);
      updated++;
    }
  }
}

// rebuild indexes by importing propagate
import { initializeTree } from "../org/propagate.js";
initializeTree(TEAM_ID);
// trigger index rebuild via a no-op propagate
import { propagatePerson } from "../org/propagate.js";
const anyPerson = allFilesInDir(TEAM_ID, "people").find((f) => f.name !== "_index.mdx");
if (anyPerson) {
  propagatePerson(TEAM_ID, { name: anyPerson.frontmatter.name, slackId: anyPerson.frontmatter.slack_id });
}

console.log(`Updated confidence on ${updated} files`);
