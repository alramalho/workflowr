import {
  allFilesInDir,
  deleteFile,
  fileExists,
  findByFrontmatter,
  readFrontmatter,
  writeFile,
  type OrgFile,
} from "./store.js";
import { slugify } from "./slug.js";

async function resolvePersonFile(
  teamId: string,
  signal: { slackId?: string; email?: string; linearId?: string; name: string },
): Promise<{ path: string; frontmatter: Record<string, any> } | null> {
  if (signal.slackId) {
    const match = await findByFrontmatter(teamId, "slack_id", signal.slackId, "people");
    if (match.length > 0) return { path: match[0].path, frontmatter: match[0].frontmatter };
  }
  if (signal.email) {
    const match = await findByFrontmatter(teamId, "email", signal.email.toLowerCase(), "people");
    if (match.length > 0) return { path: match[0].path, frontmatter: match[0].frontmatter };
  }
  if (signal.linearId) {
    const match = await findByFrontmatter(teamId, "linear_id", signal.linearId, "people");
    if (match.length > 0) return { path: match[0].path, frontmatter: match[0].frontmatter };
  }

  const slug = slugify(signal.name);
  const internal = await readFrontmatter(teamId, `people/${slug}.mdx`);
  if (internal) return { path: `people/${slug}.mdx`, frontmatter: internal };

  const external = await readFrontmatter(teamId, `people/external/${slug}.mdx`);
  if (external) return { path: `people/external/${slug}.mdx`, frontmatter: external };

  return null;
}

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

export async function propagatePerson(teamId: string, signal: PersonSignal): Promise<void> {
  const existing = await resolvePersonFile(teamId, signal);
  const fm: Record<string, any> = existing?.frontmatter ?? {};

  fm.name = signal.name;
  if (signal.slackId) fm.slack_id = signal.slackId;
  if (signal.email) fm.email = signal.email.toLowerCase();
  if (signal.linearId) fm.linear_id = signal.linearId;

  const overrides: Record<string, boolean> = fm.user_overrides ?? {};
  if (signal.role !== undefined && !overrides.role) fm.role = signal.role;
  if (signal.reportsTo !== undefined && !overrides.reports_to) fm.reports_to = signal.reportsTo;
  if (signal.isExternal !== undefined) fm.is_external = signal.isExternal;
  if (fm.is_external === undefined) fm.is_external = false;
  if (signal.writingStyle !== undefined) fm.writing_style = signal.writingStyle;
  if (signal.representativeExampleMessage !== undefined) {
    fm.representative_example_message = signal.representativeExampleMessage;
  }
  if (signal.problemToSolve !== undefined) fm.problem_to_solve = signal.problemToSolve;
  if (signal.userOverrides !== undefined) fm.user_overrides = { ...overrides, ...signal.userOverrides };
  if (signal.teams?.length && !overrides.teams) fm.teams = signal.teams;

  const teams = fm.teams as string[] | undefined;
  const hasRole = !!fm.role && fm.role !== "unknown";
  const hasTeam = !!teams?.length;
  const hasWritingStyle = !!fm.writing_style;
  fm.confidence = hasRole && hasTeam ? (hasWritingStyle ? "high" : "medium") : "low";

  const contentLines: string[] = [];
  if (teams?.length) {
    contentLines.push("## Teams");
    for (const team of teams) {
      contentLines.push(`- [@teams/${slugify(team)}.mdx]`);
    }
  }

  const newDir = fm.is_external ? "people/external" : "people";
  const newPath = `${newDir}/${slugify(signal.name)}.mdx`;
  if (existing && existing.path !== newPath) {
    await deleteFile(teamId, existing.path);
  }

  await writeFile(teamId, newPath, fm, contentLines.join("\n"), {
    entityType: "Person",
    source: "context-engine",
  });
  await rebuildPeopleIndex(teamId);

  if (teams?.length) {
    for (const teamName of teams) {
      await ensureTeamFile(teamId, teamName);
    }
    await rebuildTeamsIndex(teamId);
  }
}

export interface TeamSignal {
  name: string;
  tools?: string[];
}

export async function propagateTeam(teamId: string, signal: TeamSignal): Promise<void> {
  await ensureTeamFile(teamId, signal.name, signal.tools);
  await rebuildTeamsIndex(teamId);
}

async function ensureTeamFile(teamId: string, teamName: string, tools?: string[]): Promise<void> {
  const slug = slugify(teamName);
  const filePath = `teams/${slug}.mdx`;
  const existing = await readFrontmatter(teamId, filePath);
  const fm: Record<string, any> = existing ?? { name: teamName };
  if (tools) fm.tools = tools;
  if (!fm.name) fm.name = teamName;

  const people = (await allPeopleFiles(teamId)).filter(
    (file) => (file.frontmatter.teams as string[] | undefined)?.some(
      (team) => slugify(team) === slug,
    ),
  );

  const contentLines = ["## Members"];
  for (const person of people) {
    const role = person.frontmatter.role ? ` - ${person.frontmatter.role}` : "";
    contentLines.push(`- [${person.frontmatter.name}](@${person.path})${role}`);
  }

  await writeFile(teamId, filePath, fm, contentLines.join("\n"), {
    entityType: "Team",
    source: "context-engine",
  });
}

async function allPeopleFiles(teamId: string): Promise<OrgFile[]> {
  return [
    ...(await allFilesInDir(teamId, "people")).filter((file) => file.name !== "_index.mdx"),
    ...(await allFilesInDir(teamId, "people/external")).filter((file) => file.name !== "_index.mdx"),
  ];
}

async function rebuildPeopleIndex(teamId: string): Promise<void> {
  const people = (await allPeopleFiles(teamId)).filter((file) => !file.frontmatter.is_external);
  const confirmed = people.filter((person) => person.frontmatter.confidence !== "low");
  const incomplete = people.filter((person) => person.frontmatter.confidence === "low");

  const fmtRow = (person: OrgFile) => {
    const fm = person.frontmatter;
    const teams = (fm.teams as string[] | undefined)?.join(", ") ?? "-";
    return `| [${fm.name}](@${person.path}) | ${fm.role ?? "-"} | ${teams} |`;
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

  await writeFile(teamId, "people/_index.mdx", { kind: "index" }, sections.join("\n"), {
    entityType: "Index",
    source: "context-engine",
  });

  const externals = (await allPeopleFiles(teamId)).filter((file) => file.frontmatter.is_external);
  const extRows = externals.map((person) => {
    const fm = person.frontmatter;
    return `| [${fm.name}](@${person.path}) | ${fm.role ?? "-"} |`;
  });
  const extContent = [
    "| Name | Role |",
    "|------|------|",
    ...extRows,
  ].join("\n");
  await writeFile(teamId, "people/external/_index.mdx", { kind: "index" }, extContent, {
    entityType: "Index",
    source: "context-engine",
  });
}

async function rebuildTeamsIndex(teamId: string): Promise<void> {
  const teams = (await allFilesInDir(teamId, "teams")).filter((file) => file.name !== "_index.mdx");
  const people = await allPeopleFiles(teamId);

  const rows = teams.map((team) => {
    const fm = team.frontmatter;
    const tools = (fm.tools as string[] | undefined)?.join(", ") ?? "-";
    const members = people.filter(
      (person) => (person.frontmatter.teams as string[] | undefined)?.some(
        (teamName) => slugify(teamName) === slugify(fm.name),
      ),
    ).length;
    return `| [${fm.name}](@teams/${team.name}) | ${members} | ${tools} |`;
  });

  const content = [
    "| Team | Members | Tools |",
    "|------|---------|-------|",
    ...rows,
  ].join("\n");

  await writeFile(teamId, "teams/_index.mdx", { kind: "index" }, content, {
    entityType: "Index",
    source: "context-engine",
  });
}

export interface OrgInfo {
  name: string;
  url?: string;
  description?: string;
  industry?: string;
  location?: string;
}

export async function propagateOverview(teamId: string, org: OrgInfo, guidelines?: string): Promise<void> {
  const fm: Record<string, any> = { name: org.name };
  if (org.url) fm.url = org.url;
  if (org.description) fm.description = org.description;
  if (org.industry) fm.industry = org.industry;
  if (org.location) fm.location = org.location;

  const people = (await allFilesInDir(teamId, "people")).filter((file) => file.name !== "_index.mdx");
  const internal = people.filter((person) => !person.frontmatter.is_external).length;
  const external = people.filter((person) => person.frontmatter.is_external).length;

  const contentLines = [
    "## Headcount",
    `- Internal: ${internal}`,
    `- External: ${external}`,
  ];

  if (guidelines) {
    contentLines.push("", "## Guidelines", guidelines);
  }

  await writeFile(teamId, "overview.mdx", fm, contentLines.join("\n"), {
    entityType: "Organization",
    source: "context-engine",
  });
}

export async function initializeTree(teamId: string): Promise<void> {
  if (!(await fileExists(teamId, "people/_index.mdx"))) {
    await writeFile(teamId, "people/_index.mdx", { kind: "index" }, "| Name | Role | Teams |\n|------|------|-------|", {
      entityType: "Index",
      source: "context-engine",
    });
  }
  if (!(await fileExists(teamId, "people/external/_index.mdx"))) {
    await writeFile(teamId, "people/external/_index.mdx", { kind: "index" }, "| Name | Role |\n|------|------|", {
      entityType: "Index",
      source: "context-engine",
    });
  }
  if (!(await fileExists(teamId, "teams/_index.mdx"))) {
    await writeFile(teamId, "teams/_index.mdx", { kind: "index" }, "| Team | Members | Tools |\n|------|---------|-------|", {
      entityType: "Index",
      source: "context-engine",
    });
  }
  if (!(await fileExists(teamId, "overview.mdx"))) {
    await writeFile(teamId, "overview.mdx", { name: "Unknown" }, "", {
      entityType: "Organization",
      source: "context-engine",
    });
  }
}

export async function findPersonBySlackId(
  teamId: string,
  slackId: string,
): Promise<{ path: string; frontmatter: Record<string, any> } | null> {
  const results = await findByFrontmatter(teamId, "slack_id", slackId, "people");
  if (results.length === 0) return null;
  return { path: results[0].path, frontmatter: results[0].frontmatter };
}

export async function findPersonByLinearId(
  teamId: string,
  linearId: string,
): Promise<{ path: string; frontmatter: Record<string, any> } | null> {
  const results = await findByFrontmatter(teamId, "linear_id", linearId, "people");
  if (results.length === 0) return null;
  return { path: results[0].path, frontmatter: results[0].frontmatter };
}

export async function findPersonByEmail(
  teamId: string,
  email: string,
): Promise<{ path: string; frontmatter: Record<string, any> } | null> {
  const results = await findByFrontmatter(teamId, "email", email.toLowerCase(), "people");
  if (results.length === 0) return null;
  return { path: results[0].path, frontmatter: results[0].frontmatter };
}
