(globalThis as any).AI_SDK_LOG_WARNINGS = false;
import { App } from "@slack/bolt";
import cron from "node-cron";
import { config } from "./config.js";
import { registerCommands } from "./listeners/commands.js";
import { registerEvents } from "./listeners/events.js";
import { registerActions } from "./listeners/actions.js";
import { sendWeeklyReport } from "./jobs/weekly-report.js";
import { startAgentWorker } from "./queues/agent-queue.js";
import { startDelayedJobsWorker } from "./queues/delayed-jobs-queue.js";
import { setupOrgAwareness } from "./org/awareness.js";
import { setupStaleIssuesReporter } from "./jobs/linear-stale-issues.js";
import { setupTaskStepExecutor } from "./jobs/task-step-executor.js";
import { startOAuthServer } from "./oauth-server.js";
import { setupRunnerServer } from "./runner/server.js";

const app = new App({
  token: config.slack.botToken,
  signingSecret: config.slack.signingSecret,
  appToken: config.slack.appToken,
  socketMode: true,
});

registerCommands(app);
registerEvents(app);
registerActions(app);
if (process.env.ORG_AWARENESS_ENABLED === "true") {
  setupOrgAwareness(app);
}
setupStaleIssuesReporter(app);
setupTaskStepExecutor(app);

// --- Config ---

const AI_CHANNEL = process.env.AI_CHANNEL ?? "C_YOUR_CHANNEL_ID";
const REPOS = [{ owner: "chatarmin", repo: "slack-workflows" }];

// --- Cron jobs ---

// Weekly report — every Friday at 17:00
// cron.schedule("0 17 * * 5", () => {
//   sendWeeklyReport(app, AI_CHANNEL, REPOS).catch(console.error);
// });

(async () => {
  await app.start();
  console.log("Slack bot is running");

  const agentWorker = startAgentWorker(app);
  const delayedWorker = startDelayedJobsWorker(app);
  const { expressApp, httpServer } = startOAuthServer(config.oauthPort, { slackApp: app, channel: AI_CHANNEL, repos: REPOS });
  setupRunnerServer(httpServer, expressApp, app);

  const shutdown = async () => {
    console.log("[shutdown] closing workers, waiting for in-flight jobs...");
    await Promise.all([agentWorker.close(), delayedWorker.close()]);
    await app.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
})();
