import Supermemory from "supermemory";
import { config } from "../config.js";

let _client: Supermemory | undefined;
function client() {
  if (!_client) _client = new Supermemory({ apiKey: config.ai.supermemoryApiKey });
  return _client;
}

export const userTag = (slackUserId: string) => `user_${slackUserId}`;
export const orgTag = (teamId: string) => `org_${teamId}`;

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
