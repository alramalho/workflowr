import { writeFile, allFilesInDir, findByFrontmatter, readFrontmatter, fileExists, deleteFile, type OrgFile } from "./tree.js";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// --- identity resolution ---

function resolvePersonFile(
  teamId: string,
  signal: { slackId?: string; email?: string; linearId?: string; name: string },
): { path: string; frontmatter: Record<string, any> } | null {
  // try exact identity keys in priority order
  if (signal.slackId) {
    const match = findByFrontmatter(teamId, "slack_id", signal.slackId, "people");
    if (match.length > 0) return { path: match[0].path, frontmatter: match[0].frontmatter };
  }
  if (signal.email) {
    const match = findByFrontmatter(teamId, "email", signal.email.toLowerCase(), "people");
    if (match.length > 0) return { path: match[0].path, frontmatter: match[0].frontmatter };
  }
  if (signal.linearId) {
    const match = findByFrontmatter(teamId, "linear_id", signal.linearId, "people");
    if (match.length > 0) return { path: match[0].path, frontmatter: match[0].frontmatter };
  }
  // try by filename (slugified name)
  const slug = slugify(signal.name);
  const fm = readFrontmatter(teamId, `people/${slug}.mdx`);
  if (fm) return { path: `people/${slug}.mdx`, frontmatter: fm };

  return null;
}

// --- person ---

export interface PersonSignal {
  name: string;
  slackId?: string;
  email?: string;
  linearId?: string;
  role?: string;
  reportsTo?: string;
  teams?: string[];
  isExternal?: boolean;
  writingStyle?: string;
  representativeExampleMessage?: string;
  problemToSolve?: string;
  userOverrides?: Record<string, boolean>;
}

export function propagatePerson(teamId: string, signal: PersonSignal): void {
  const existing = resolvePersonFile(teamId, signal);
  const isExternal = signal.isExternal ?? existing?.frontmatter.is_external ?? false;
  const dir = isExternal ? "people/external" : "people";
  const filePath = existing?.path ?? `${dir}/${slugify(signal.name)}.mdx`;
  const fm: Record<string, any> = existing?.frontmatter ?? {};

  // always set name; identity keys accumulate (never remove)
  fm.name = signal.name;
  if (signal.slackId) fm.slack_id = signal.slackId;
  if (signal.email) fm.email = signal.email.toLowerCase();
  if (signal.linearId) fm.linear_id = signal.linearId;

  // respect user overrides
  const overrides: Record<string, boolean> = fm.user_overrides ?? {};
  if (signal.role !== undefined && !overrides.role) fm.role = signal.role;
  if (signal.reportsTo !== undefined && !overrides.reports_to) fm.reports_to = signal.reportsTo;
  if (signal.isExternal !== undefined) fm.is_external = signal.isExternal;
  if (signal.writingStyle !== undefined) fm.writing_style = signal.writingStyle;
  if (signal.representativeExampleMessage !== undefined) fm.representative_example_message = signal.representativeExampleMessage;
  if (signal.problemToSolve !== undefined) fm.problem_to_solve = signal.problemToSolve;
  if (signal.userOverrides !== undefined) fm.user_overrides = { ...overrides, ...signal.userOverrides };
  if (signal.teams?.length && !overrides.teams) fm.teams = signal.teams;

  // compute confidence from data completeness
  const hasRole = !!fm.role && fm.role !== "unknown";
  const hasTeam = !!(fm.teams as string[] | undefined)?.length;
  const hasWritingStyle = !!fm.writing_style;
  fm.confidence = hasRole && hasTeam ? (hasWritingStyle ? "high" : "medium") : "low";

  const contentLines: string[] = [];
  const teams = fm.teams as string[] | undefined;
  if (teams?.length) {
    contentLines.push("## Teams");
    for (const t of teams) {
      contentLines.push(`- [@teams/${slugify(t)}.mdx]`);
    }
  }

  // handle rename or internal/external move: delete old file if path changed
  const newDir = (fm.is_external) ? "people/external" : "people";
  const newPath = `${newDir}/${slugify(signal.name)}.mdx`;
  if (existing && existing.path !== newPath) {
    deleteFile(teamId, existing.path);
  }

  writeFile(teamId, newPath, fm, contentLines.join("\n"));
  rebuildPeopleIndex(teamId);

  if (teams?.length) {
    for (const teamName of teams) {
      ensureTeamFile(teamId, teamName);
    }
    rebuildTeamsIndex(teamId);
  }
}

// --- team ---

export interface TeamSignal {
  name: string;
  tools?: string[];
}

export function propagateTeam(teamId: string, signal: TeamSignal): void {
  ensureTeamFile(teamId, signal.name, signal.tools);
  rebuildTeamsIndex(teamId);
}

function ensureTeamFile(teamId: string, teamName: string, tools?: string[]): void {
  const slug = slugify(teamName);
  const filePath = `teams/${slug}.mdx`;

  const existing = readFrontmatter(teamId, filePath);
  const fm: Record<string, any> = existing ?? { name: teamName };
  if (tools) fm.tools = tools;
  if (!fm.name) fm.name = teamName;

  const people = allPeopleFiles(teamId).filter(
    (f) => (f.frontmatter.teams as string[] | undefined)?.some(
      (t) => slugify(t) === slug,
    ),
  );

  const contentLines = ["## Members"];
  for (const p of people) {
    const role = p.frontmatter.role ? ` — ${p.frontmatter.role}` : "";
    contentLines.push(`- [${p.frontmatter.name}](@${p.path})${role}`);
  }

  writeFile(teamId, filePath, fm, contentLines.join("\n"));
}

// --- index rebuilding ---

function allPeopleFiles(teamId: string): ReturnType<typeof allFilesInDir> {
  return [
    ...allFilesInDir(teamId, "people").filter((f) => f.name !== "_index.mdx"),
    ...allFilesInDir(teamId, "people/external").filter((f) => f.name !== "_index.mdx"),
  ];
}

function rebuildPeopleIndex(teamId: string): void {
  const people = allPeopleFiles(teamId).filter((f) => !f.frontmatter.is_external);
  const confirmed = people.filter((p) => p.frontmatter.confidence !== "low");
  const incomplete = people.filter((p) => p.frontmatter.confidence === "low");

  const fmtRow = (p: ReturnType<typeof allPeopleFiles>[number]) => {
    const fm = p.frontmatter;
    const teams = (fm.teams as string[] | undefined)?.join(", ") ?? "—";
    return `| [${fm.name}](@${p.path}) | ${fm.role ?? "—"} | ${teams} |`;
  };

  const sections = [
    "| Name | Role | Teams |",
    "|------|------|-------|",
    ...confirmed.map(fmtRow),
  ];

  if (incomplete.length > 0) {
    sections.push(
      "",
      `## Incomplete profiles (${incomplete.length})`,
      "These people were seen in Slack but have insufficient data (no role or team identified yet).",
      "",
      "| Name | Role | Teams |",
      "|------|------|-------|",
      ...incomplete.map(fmtRow),
    );
  }

  const content = sections.join("\n");

  writeFile(teamId, "people/_index.mdx", { kind: "index" }, content);

  // external people index
  const externals = allPeopleFiles(teamId).filter((f) => f.frontmatter.is_external);
  const extRows = externals.map((p) => {
    const fm = p.frontmatter;
    return `| [${fm.name}](@${p.path}) | ${fm.role ?? "—"} |`;
  });
  const extContent = [
    "| Name | Role |",
    "|------|------|",
    ...extRows,
  ].join("\n");
  writeFile(teamId, "people/external/_index.mdx", { kind: "index" }, extContent);
}

function rebuildTeamsIndex(teamId: string): void {
  const teams = allFilesInDir(teamId, "teams").filter((f) => f.name !== "_index.mdx");

  const rows = teams.map((t) => {
    const fm = t.frontmatter;
    const tools = (fm.tools as string[] | undefined)?.join(", ") ?? "—";
    const members = allPeopleFiles(teamId).filter(
      (p) => (p.frontmatter.teams as string[] | undefined)?.some(
        (tn) => slugify(tn) === slugify(fm.name),
      ),
    ).length;
    return `| [${fm.name}](@teams/${t.name}) | ${members} | ${tools} |`;
  });

  const content = [
    "| Team | Members | Tools |",
    "|------|---------|-------|",
    ...rows,
  ].join("\n");

  writeFile(teamId, "teams/_index.mdx", { kind: "index" }, content);
}

// --- overview ---

export interface OrgInfo {
  name: string;
  url?: string;
  description?: string;
  industry?: string;
  location?: string;
}

export function propagateOverview(teamId: string, org: OrgInfo, guidelines?: string): void {
  const fm: Record<string, any> = { name: org.name };
  if (org.url) fm.url = org.url;
  if (org.description) fm.description = org.description;
  if (org.industry) fm.industry = org.industry;
  if (org.location) fm.location = org.location;

  const people = allFilesInDir(teamId, "people").filter((f) => f.name !== "_index.mdx");
  const internal = people.filter((p) => !p.frontmatter.is_external).length;
  const external = people.filter((p) => p.frontmatter.is_external).length;

  const contentLines = [
    "## Headcount",
    `- Internal: ${internal}`,
    `- External: ${external}`,
  ];

  if (guidelines) {
    contentLines.push("", "## Guidelines", guidelines);
  }

  writeFile(teamId, "overview.mdx", fm, contentLines.join("\n"));
}

// --- initialization ---

export function initializeTree(teamId: string): void {
  if (!fileExists(teamId, "people/_index.mdx")) {
    writeFile(teamId, "people/_index.mdx", { kind: "index" }, "| Name | Role | Teams |\n|------|------|-------|");
  }
  if (!fileExists(teamId, "people/external/_index.mdx")) {
    writeFile(teamId, "people/external/_index.mdx", { kind: "index" }, "| Name | Role |\n|------|------|");
  }
  if (!fileExists(teamId, "teams/_index.mdx")) {
    writeFile(teamId, "teams/_index.mdx", { kind: "index" }, "| Team | Members | Tools |\n|------|---------|-------|");
  }
  if (!fileExists(teamId, "overview.mdx")) {
    writeFile(teamId, "overview.mdx", { name: "Unknown" }, "");
  }
}

// --- lookup helpers ---

export function findPersonBySlackId(teamId: string, slackId: string): { path: string; frontmatter: Record<string, any> } | null {
  const results = findByFrontmatter(teamId, "slack_id", slackId, "people");
  if (results.length === 0) return null;
  return { path: results[0].path, frontmatter: results[0].frontmatter };
}

export function findPersonByLinearId(teamId: string, linearId: string): { path: string; frontmatter: Record<string, any> } | null {
  const results = findByFrontmatter(teamId, "linear_id", linearId, "people");
  if (results.length === 0) return null;
  return { path: results[0].path, frontmatter: results[0].frontmatter };
}

export function findPersonByEmail(teamId: string, email: string): { path: string; frontmatter: Record<string, any> } | null {
  const results = findByFrontmatter(teamId, "email", email.toLowerCase(), "people");
  if (results.length === 0) return null;
  return { path: results[0].path, frontmatter: results[0].frontmatter };
}
