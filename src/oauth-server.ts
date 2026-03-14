import type { App as SlackApp } from "@slack/bolt";
import express from "express";
import { google } from "googleapis";
import { config } from "./config.js";
import { upsertToken } from "./db/tokens.js";
import { sendWeeklyReport } from "./jobs/weekly-report.js";
import { getAllOrgMembers } from "./db/org-members.js";
import { clearThreadLocks } from "./db/thread-reads.js";
import { analyzeThread, bootstrapOrgAwareness, buildOrgChart } from "./jobs/org-awareness.js";
import { getOrgByTeamId, getAllOrgs } from "./db/orgs.js";
import { getTeamsForMember } from "./db/teams.js";

interface ServerOptions {
  slackApp: SlackApp;
  channel: string;
  repos: { owner: string; repo: string }[];
}

export function startOAuthServer(port: number, opts: ServerOptions) {
  const app = express();

  app.get("/health", (_req, res) => {
    res.send("ok");
  });

  app.post("/trigger/weekly-report", async (_req, res) => {
    try {
      await sendWeeklyReport(opts.slackApp, opts.channel, opts.repos);
      res.send("Weekly report sent.");
    } catch (err) {
      console.error("Manual weekly report error:", err);
      res.status(500).send("Failed to send weekly report.");
    }
  });

  app.get("/debug/org", (_req, res) => {
    const members = getAllOrgMembers();
    const hierarchy = members.map((m) => {
      const manager = m.reports_to
        ? members.find((o) => o.slack_id === m.reports_to)?.name ?? m.reports_to
        : null;
      const teams = getTeamsForMember(m.id).map((t) => t.name);
      return {
        name: m.name,
        slackId: m.slack_id,
        role: m.role,
        teams,
        isExternal: !!m.is_external,
        reportsTo: manager,
        writingStyle: m.writing_style,
        representativeExampleMessage: m.representative_example_message,
        updatedAt: m.updated_at,
      };
    });
    res.json(hierarchy);
  });

  app.post("/trigger/org-rewatch", express.json(), async (req, res) => {
    const { notifySlackId } = req.body ?? {};
    let slackTeamId: string | undefined = req.body?.slackTeamId;

    // default to the only org, require slackTeamId if multiple
    if (!slackTeamId) {
      const orgs = getAllOrgs().filter((o) => o.team_id);
      if (orgs.length === 0) {
        res.status(400).json({ error: "No organization set up. Run /org-setup first." });
        return;
      }
      if (orgs.length > 1) {
        res.status(400).json({
          error: "Multiple organizations found. Provide slackTeamId.",
          orgs: orgs.map((o) => ({ slackTeamId: o.team_id, name: o.name })),
        });
        return;
      }
      slackTeamId = orgs[0].team_id!;
    }

    if (!getOrgByTeamId(slackTeamId)) {
      res.status(400).json({ error: "Organization not set up for this workspace" });
      return;
    }

    res.json({ status: "started", slackTeamId });

    // clear all thread locks and re-bootstrap
    clearThreadLocks();

    bootstrapOrgAwareness(opts.slackApp, slackTeamId).then((count) => {
      const chart = buildOrgChart(slackTeamId);
      console.log(`[org-rewatch] Done: analyzed ${count} threads for workspace ${slackTeamId}`);
      if (notifySlackId) {
        opts.slackApp.client.chat.postMessage({
          channel: notifySlackId,
          text: `Org rewatch complete — analyzed ${count} threads.\n\n${chart}`,
        });
      }
    }).catch((err) => {
      console.error("[org-rewatch] Error:", err);
      if (notifySlackId) {
        opts.slackApp.client.chat.postMessage({
          channel: notifySlackId,
          text: "Org rewatch failed. Check logs for details.",
        });
      }
    });
  });

  app.get("/auth/google/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;

    if (!code || !state) {
      res.status(400).send("Missing code or state parameter.");
      return;
    }

    try {
      const oauth2 = new google.auth.OAuth2(
        config.google.clientId,
        config.google.clientSecret,
        config.google.redirectUri
      );

      const { tokens } = await oauth2.getToken(code);

      if (!tokens.refresh_token) {
        res.status(400).send(
          "No refresh token received. You may have already authorized this app. " +
          "Revoke access at https://myaccount.google.com/permissions and try again."
        );
        return;
      }

      let email: string | undefined;
      try {
        oauth2.setCredentials(tokens);
        const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 });
        const { data } = await oauth2Api.userinfo.get();
        email = data.email ?? undefined;
      } catch {
        // non-critical, continue without email
      }

      upsertToken(state, tokens.refresh_token, email);

      res.send("Google account connected successfully! You can close this tab and return to Slack.");
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.status(500).send("Failed to connect Google account. Please try again.");
    }
  });

  app.listen(port, () => {
    console.log(`OAuth callback server listening on port ${port}`);
  });
}
