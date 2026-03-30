import type { App } from "@slack/bolt";
import type { ArtifactStore } from "../artifacts.js";

export interface ToolHistoryEntry {
  tool: string;
  input: unknown;
  output: unknown;
}

export interface SubagentContext {
  app: App;
  slackUserId?: string;
  teamId?: string;
  conversationHistory?: string;
  channelId?: string;
  threadTs?: string;
  toolHistory?: ToolHistoryEntry[];
  artifacts?: ArtifactStore;
}
