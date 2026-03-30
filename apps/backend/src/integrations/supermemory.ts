import Supermemory from "supermemory";
import { generateText, generateObject } from "../utils/ai.js";
import { z } from "zod";
import { config } from "../config.js";

let _client: Supermemory | undefined;
function client() {
  if (!_client) _client = new Supermemory({ apiKey: config.ai.supermemoryApiKey });
  return _client;
}

const PROJECT = "workflowr";
export const userTag = (slackUserId: string) => `${PROJECT}:user_${slackUserId}`;
export const orgTag = (teamId: string) => `${PROJECT}:org_${teamId}`;
export const dbSchemaTag = () => `${PROJECT}:db_schema`;
export const codebaseTag = () => `${PROJECT}:codebase`;

export async function searchMemories(
  query: string,
  containerTags: string[],
  limit = 5,
) {
  const res = await client().search.execute({
    q: query,
    containerTags,
    limit,
  });
  return res.results;
}

export async function addMemory(content: string, containerTag: string) {
  return client().documents.add({ content, containerTag });
}

export async function listMemories(
  containerTag: string,
  limit = 15,
  page = 1,
) {
  return client().documents.list({
    containerTags: [containerTag],
    limit,
    page,
    includeContent: true,
    sort: "createdAt",
    order: "desc",
  });
}

export async function deleteMemory(id: string) {
  return client().documents.delete(id);
}

export async function reconcileMemories(
  newContent: string,
  existing: { id: string; text: string }[],
): Promise<{ action: "skip" | "save" | "reconcile"; memories?: string[]; deleteIds?: string[] }> {
  if (!existing.length) return { action: "save" };

  const result = await generateObject({
    model: "google/gemini-3-flash-preview",
    schema: z.object({
      action: z.enum(["skip", "save", "reconcile"]).describe(
        "skip = new memory is fully redundant; save = new memory covers a different topic; reconcile = overlap detected, return merged atomic memories"
      ),
      memories: z.array(z.string()).optional().describe(
        "Only for 'reconcile': the optimal set of atomic memories combining old + new info. Each should cover exactly one concept."
      ),
      deleteIds: z.array(z.string()).optional().describe(
        "Only for 'reconcile': IDs of existing memories that are now covered by the new set"
      ),
    }),
    prompt: `You manage a memory store. A new memory is being saved. Check if it overlaps with existing memories.

New memory:
${newContent}

Existing memories:
${existing.map((e) => `[${e.id}] ${e.text}`).join("\n")}

Rules:
- "skip" if the new memory adds zero new information over existing ones.
- "save" if the new memory is about a genuinely different topic.
- "reconcile" if there's overlap: produce the best set of atomic memories (one concept each) that combines all info from both old and new WITHOUT losing any detail. Return the IDs of old memories that are now redundant.
  Example: if existing says "Alex's deliverables are in the canvas" and new adds "the canvas is the single source of truth for sprint tasks", reconcile into two atomic memories: one about where to find deliverables, one about the canvas being the sprint source of truth.`,
  });

  return result.object;
}

export async function rephraseMemory(raw: string, teamId?: string): Promise<string> {
  try {
    const linkHint = teamId
      ? `\nWhen the text references Slack channels (C...) or canvases (F...), include navigable links: channels → <https://app.slack.com/client/${teamId}/{id}|#channel-name or ID>, canvases → <https://app.slack.com/docs/${teamId}/{id}|canvas title or ID>. Keep the raw ID visible in the link text too (e.g. "Deliverables canvas <https://app.slack.com/docs/${teamId}/F0AJDES0J65|F0AJDES0J65>").`
      : "";
    const result = await generateText({
      model: "google/gemini-3-flash-preview",
      prompt: `Rephrase this into a concise, outcome-oriented memory. Use the pattern: trigger → action → expected outcome (when applicable). Strip conversational filler, keep concrete details (tool names, IDs, specific values).${linkHint}\nReturn ONLY the rephrased text, nothing else.\n\nRaw: ${raw}`,
    });
    return result.text.trim() || raw;
  } catch {
    return raw;
  }
}
