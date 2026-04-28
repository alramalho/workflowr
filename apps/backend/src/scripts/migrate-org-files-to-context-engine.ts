import { writeFile } from "context-engine";
import db from "../db/index.js";

interface LegacyOrgFileRow {
  team_id: string;
  path: string;
  frontmatter: string;
  content: string;
}

function parseFrontmatter(raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'org_files'")
    .get();

  if (!table) {
    console.log("[context-engine] No legacy org_files table found. Nothing to import.");
    return;
  }

  const rows = db
    .prepare("SELECT team_id, path, frontmatter, content FROM org_files ORDER BY team_id, path")
    .all() as LegacyOrgFileRow[];

  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.team_id || !row.path) {
      skipped++;
      continue;
    }

    await writeFile(
      row.team_id,
      row.path,
      parseFrontmatter(row.frontmatter),
      row.content ?? "",
      { source: "legacy-org-files" },
    );
    imported++;
  }

  const skippedText = skipped > 0 ? `, ${skipped} skipped` : "";
  console.log(`[context-engine] Imported ${imported} legacy org_files rows${skippedText}.`);
}

main().catch((error) => {
  console.error("[context-engine] Legacy org_files import failed:", error);
  process.exitCode = 1;
});
