(globalThis as any).AI_SDK_LOG_WARNINGS = false;
import { App } from "@slack/bolt";
import cron from "node-cron";
import { config } from "./config.js";
import { registerCommands } from "./listeners/commands.js";
import { registerEvents } from "./listeners/events.js";
import { registerActions } from "./listeners/actions.js";
import { sendWeeklyReport } from "./jobs/weekly-report.js";
import { startMeetingWatcher } from "./jobs/meeting-watcher.js";
import { startJobRunner } from "./jobs/job-runner.js";
import { setupLinearDoneNudge } from "./jobs/linear-done-nudge.js";
import { setupOrgAwareness } from "./jobs/org-awareness.js";
import { setupStaleIssuesReporter } from "./jobs/linear-stale-issues.js";
import { startOAuthServer } from "./oauth-server.js";

const app = new App({
  token: config.slack.botToken,
  signingSecret: config.slack.signingSecret,
  appToken: config.slack.appToken,
  socketMode: true,
});

registerCommands(app);
registerEvents(app);
registerActions(app);
setupLinearDoneNudge(app);
setupOrgAwareness(app);
setupStaleIssuesReporter(app);

// --- Config ---

const AI_CHANNEL = process.env.AI_CHANNEL ?? "C_YOUR_CHANNEL_ID";
const REPOS = [{ owner: "chatarmin", repo: "slack-workflows" }];

// --- Cron jobs ---

// Weekly report — every Friday at 17:00
// cron.schedule("0 17 * * 5", () => {
//   sendWeeklyReport(app, AI_CHANNEL, REPOS).catch(console.error);
// });

// --- Meeting watcher ---
// Polls calendar every 15min, schedules deliverables post 10min after meeting ends
// Handles rescheduled meetings automatically
// startMeetingWatcher(app, AI_CHANNEL);

(async () => {
  await app.start();
  console.log("Slack bot is running");

  startJobRunner(app);
  startOAuthServer(config.oauthPort, { slackApp: app, channel: AI_CHANNEL, repos: REPOS });
})();
