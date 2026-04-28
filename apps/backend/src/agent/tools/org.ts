import { tool } from "ai";
import { z } from "zod";
import * as tree from "../../org/tree.js";

export function createOrgTools(teamId?: string) {
  if (!teamId) return {};

  return {
    org_ls: tool({
      description: "List contents of a directory in the org knowledge tree. Start with org_ls('.') to see the top-level structure. Directories end with /.",
      inputSchema: z.object({
        path: z.string().describe("Directory path, e.g. '.' or 'people' or 'teams'"),
      }),
      execute: async ({ path }) => {
        const entries = await tree.ls(teamId, path);
        if (entries.length === 0) return "Empty directory.";
        return entries.join("\n");
      },
    }),

    org_cat: tool({
      description: "Read a file from the org knowledge tree. Returns the full MDX content with frontmatter.",
      inputSchema: z.object({
        path: z.string().describe("File path, e.g. 'people/alex.mdx' or 'teams/_index.mdx'"),
      }),
      execute: async ({ path }) => {
        const content = await tree.cat(teamId, path);
        if (!content) return `File not found: ${path}`;
        return content;
      },
    }),

    org_grep: tool({
      description: "Search for a pattern across the org knowledge tree. Case-insensitive. Returns matching file paths and lines.",
      inputSchema: z.object({
        pattern: z.string().describe("Text to search for, e.g. 'marco polo' or 'ai memory'"),
        scope: z.string().optional().describe("Limit search to a directory, e.g. 'people' or 'issues'"),
      }),
      execute: async ({ pattern, scope }) => {
        const results = await tree.grep(teamId, pattern, scope);
        if (results.length === 0) return `No matches for "${pattern}"${scope ? ` in ${scope}/` : ""}.`;
        return results
          .map((r) => `${r.path}:\n${r.matches.map((m) => `  ${m}`).join("\n")}`)
          .join("\n\n");
      },
    }),

    org_search: tool({
      description: "Search the organization context engine for relevant pages by topic, person, team, project, or phrase. Use this when exact org_grep is too narrow.",
      inputSchema: z.object({
        query: z.string().describe("Search query, e.g. 'vendor delays', 'Project Alpha', or 'Kubernetes expertise'"),
        scope: z.string().optional().describe("Optional directory scope, e.g. 'people', 'teams', or 'communications'"),
      }),
      execute: async ({ query, scope }) => {
        const results = await tree.searchPages(teamId, query, 8, scope);
        if (results.length === 0) return `No context results for "${query}"${scope ? ` in ${scope}/` : ""}.`;
        return results
          .map((result) => {
            const title = result.frontmatter.name ?? result.frontmatter.title ?? result.path;
            const matches = result.matches.map((match) => `  ${match}`).join("\n");
            return `${result.path} (${title})\n${matches}`;
          })
          .join("\n\n");
      },
    }),
  };
}
