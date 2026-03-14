import Supermemory from "supermemory";
import { generateText } from "ai";
import { createHelicone } from "@helicone/ai-sdk-provider";
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

export async function rephraseMemory(raw: string): Promise<string> {
  try {
    const helicone = createHelicone({
      apiKey: config.ai.heliconeApiKey,
      headers: { "Helicone-Property-App": "workflowr" },
    });
    const result = await generateText({
      model: helicone("gemini-3-flash-preview"),
      prompt: `Rephrase this into a concise, outcome-oriented memory. Use the pattern: trigger → action → expected outcome (when applicable). Strip conversational filler, keep concrete details (tool names, IDs, specific values). Return ONLY the rephrased text, nothing else.\n\nRaw: ${raw}`,
    });
    return result.text.trim() || raw;
  } catch {
    return raw;
  }
}
