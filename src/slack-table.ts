const TABLE_RE = /(?:^|\n)((?:\|[^\n]+\|\r?\n)(?:\|[\s:|\-]+\r?\n)((?:\|[^\n]+\|\r?\n?)*))/g;

interface RawTextCell {
  type: "raw_text";
  text: string;
}

type TableRow = RawTextCell[];

interface ColumnSetting {
  align: "left" | "center" | "right";
}

interface TableBlock {
  type: "table";
  rows: TableRow[];
  column_settings: ColumnSetting[];
}

function parseAlignment(sep: string): ColumnSetting["align"] {
  const trimmed = sep.trim();
  const left = trimmed.startsWith(":");
  const right = trimmed.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

function parseCells(row: string): string[] {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function parseMarkdownTable(tableStr: string): TableBlock {
  const lines = tableStr.trim().split(/\r?\n/).filter(Boolean);
  const headerCells = parseCells(lines[0]);
  const separatorCells = parseCells(lines[1]);
  const columnSettings = separatorCells.map((s) => ({ align: parseAlignment(s) }));

  const rows: TableRow[] = [
    headerCells.map((text) => ({ type: "raw_text" as const, text })),
  ];

  for (let i = 2; i < lines.length; i++) {
    const cells = parseCells(lines[i]);
    rows.push(cells.map((text) => ({ type: "raw_text" as const, text })));
  }

  return { type: "table", rows, column_settings: columnSettings };
}

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export function textToBlocksWithTable(text: string): { blocks: SlackBlock[]; fallbackText: string } | null {
  const match = TABLE_RE.exec(text);
  TABLE_RE.lastIndex = 0;
  if (!match) return null;

  const tableStr = match[1];
  const before = text.slice(0, match.index).trim();
  const after = text.slice(match.index + match[0].length).trim();

  const blocks: SlackBlock[] = [];

  if (before) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: before } });
  }

  blocks.push(parseMarkdownTable(tableStr) as unknown as SlackBlock);

  if (after) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: after } });
  }

  return { blocks, fallbackText: text };
}
