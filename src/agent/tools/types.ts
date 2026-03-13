import type { App } from "@slack/bolt";

export interface SubagentContext {
  app: App;
  slackUserId?: string;
  teamId?: string;
  conversationHistory?: string;
  channelId?: string;
  threadTs?: string;
}
