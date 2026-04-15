import type { App as SlackApp } from "@slack/bolt";
import http from "http";
import express from "express";
import { google } from "googleapis";
import { SignJWT, jwtVerify } from "jose";
import { config } from "./config.js";
import { upsertToken } from "./db/tokens.js";
import { upsertSlackToken } from "./db/slack-tokens.js";
import { sendWeeklyReport } from "./jobs/weekly-report.js";
import { clearThreadLocks } from "./db/thread-reads.js";
import { analyzeThread, bootstrapOrgAwareness } from "./org/awareness.js";
import { getOrgByTeamId, getAllOrgs } from "./db/orgs.js";
import { allFilesInDir, ls, cat } from "./org/tree.js";
import { runAgent } from "./agent/index.js";
import { ALLOWED_USERS } from "./listeners/events.js";

const jwtSecretKey = new TextEncoder().encode(config.jwtSecret);

interface ServerOptions {
  slackApp: SlackApp;
  channel: string;
  repos: { owner: string; repo: string }[];
}

export function startOAuthServer(port: number, opts: ServerOptions) {
  const app = express();

  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    next();
  });

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

  app.get("/debug/org", (req, res) => {
    const teamId = (req.query.teamId as string) ?? getAllOrgs().find((o) => o.team_id)?.team_id;
    if (!teamId) { res.json([]); return; }
    const people = allFilesInDir(teamId, "people").filter((f) => f.name !== "_index.mdx");
    res.json(people.map((p) => ({ path: p.path, ...p.frontmatter, updatedAt: p.updated_at })));
  });

  // JWT auth middleware for /api/* routes
  async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    try {
      const { payload } = await jwtVerify(auth.slice(7), jwtSecretKey);
      (req as any).user = { slackUserId: payload.slackUserId as string, teamId: payload.teamId as string, name: payload.name as string };
      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired token" });
    }
  }

  app.get("/api/org-tree", requireAuth, (req, res) => {
    const user = (req as any).user;
    const teamId = (req.query.teamId as string) ?? user.teamId ?? getAllOrgs().find((o) => o.team_id)?.team_id;
    if (!teamId) { res.json({ tree: [], files: {} }); return; }
    const entries = ls(teamId, ".");
    const files: Record<string, string> = {};
    const collectFiles = (dir: string) => {
      for (const entry of ls(teamId, dir)) {
        const path = dir === "." ? entry : `${dir}/${entry}`;
        if (entry.endsWith("/")) {
          collectFiles(path.replace(/\/$/, ""));
        } else {
          const content = cat(teamId, path);
          if (content) files[path] = content;
        }
      }
    };
    collectFiles(".");
    res.json({ tree: entries, files });
  });

  app.post("/api/chat", express.json(), requireAuth, async (req, res) => {
    const user = (req as any).user;
    const { messages, viewDescription } = req.body ?? {};
    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: "messages[] required" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      const userMessages = messages.filter((m: { role: string }) => m.role === "user");
      const latestPrompt = userMessages[userMessages.length - 1]?.content ?? "";

      const contextParts: string[] = [];
      if (viewDescription) {
        contextParts.push(`[Org tree view the user is currently seeing]\n${viewDescription}`);
      }
      contextParts.push("[Note: user is chatting from the web org-tree visualizer, not Slack. Use standard markdown, not Slack mrkdwn.]");
      if (messages.length > 1) {
        const prior = messages.slice(0, -1);
        const history = prior.map((m: { role: string; content: string }) =>
          `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
        ).join("\n");
        contextParts.push(`[Prior conversation]\n${history}`);
      }

      const sse = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const result = await runAgent(
        opts.slackApp,
        latestPrompt,
        contextParts.join("\n\n"),
        user.slackUserId,
        user.teamId,
        user.name,
        undefined, undefined, undefined,
        (status) => sse("status", { status }),
        undefined, undefined, undefined,
        (step) => sse("tool", step),
      );

      sse("done", { text: result.text, latencyMs: result.latencyMs });
      res.end();
    } catch (err) {
      console.error("[api/chat] error:", err);
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Failed to generate response" })}\n\n`);
      res.end();
    }
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
      console.log(`[org-rewatch] Done: analyzed ${count} threads for workspace ${slackTeamId}`);
      if (notifySlackId) {
        const summary = [cat(slackTeamId, "teams/_index.mdx"), cat(slackTeamId, "people/_index.mdx")].filter(Boolean).join("\n\n");
        opts.slackApp.client.chat.postMessage({
          channel: notifySlackId,
          text: `Org rewatch complete — analyzed ${count} threads.\n\n${summary}`,
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

  // --- Web auth (Sign in with Slack via OpenID Connect) ---

  app.get("/auth/web/start", (_req, res) => {
    if (!config.slack.clientId) {
      res.status(500).send("Slack OAuth not configured.");
      return;
    }

    const serverUrl = config.oauthServerUrl ?? `http://localhost:${config.oauthPort}`;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.slack.clientId,
      scope: "openid,profile",
      redirect_uri: `${serverUrl}/auth/web/callback`,
      nonce: Math.random().toString(36).slice(2),
    });

    res.redirect(`https://slack.com/openid/connect/authorize?${params}`);
  });

  app.get("/auth/web/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    if (!code) {
      res.status(400).send("Missing code parameter.");
      return;
    }

    try {
      const serverUrl = config.oauthServerUrl ?? `http://localhost:${config.oauthPort}`;

      // Exchange code for OIDC token
      const tokenResp = await fetch("https://slack.com/api/openid.connect.token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.slack.clientId!,
          client_secret: config.slack.clientSecret!,
          code,
          redirect_uri: `${serverUrl}/auth/web/callback`,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenResp.json() as any;
      if (!tokenData.ok) {
        console.error("Web auth OIDC token error:", tokenData.error);
        res.status(400).send(`Slack auth failed: ${tokenData.error}`);
        return;
      }

      // Get user info from OIDC
      const userResp = await fetch("https://slack.com/api/openid.connect.userInfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userData = await userResp.json() as any;
      if (!userData.ok) {
        res.status(400).send("Could not fetch user info from Slack.");
        return;
      }

      const slackUserId = userData.sub; // OIDC subject = Slack user ID
      const teamId = userData["https://slack.com/team_id"];
      if (!slackUserId || !teamId) {
        res.status(400).send("Could not identify Slack user.");
        return;
      }

      if (!(slackUserId in ALLOWED_USERS)) {
        res.status(403).send("You are not authorized to use this app.");
        return;
      }

      const name = ALLOWED_USERS[slackUserId] ?? userData.name ?? slackUserId;
      const token = await new SignJWT({ slackUserId, teamId, name })
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("30d")
        .sign(jwtSecretKey);

      res.redirect(`${config.webRedirectUri}?token=${token}`);
    } catch (err) {
      console.error("Web auth callback error:", err);
      res.status(500).send("Authentication failed. Please try again.");
    }
  });

  app.get("/auth/web/me", async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    try {
      const { payload } = await jwtVerify(auth.slice(7), jwtSecretKey);
      res.json({ slackUserId: payload.slackUserId, teamId: payload.teamId, name: payload.name });
    } catch {
      res.status(401).json({ error: "Invalid token" });
    }
  });

  // --- Existing OAuth callbacks ---

  app.get("/auth/slack/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;

    if (!code || !state) {
      res.status(400).send("Missing code or state parameter.");
      return;
    }

    try {
      const resp = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.slack.clientId!,
          client_secret: config.slack.clientSecret!,
          code,
          redirect_uri: config.slack.redirectUri!,
        }),
      });

      const data = await resp.json() as any;

      if (!data.ok) {
        console.error("Slack OAuth error:", data.error);
        res.status(400).send(`Slack OAuth failed: ${data.error}`);
        return;
      }

      const userToken = data.authed_user?.access_token;
      if (!userToken) {
        res.status(400).send("No user access token received.");
        return;
      }

      upsertSlackToken(state, userToken);

      res.send("Slack account connected for search! You can close this tab and return to Slack.");
    } catch (err) {
      console.error("Slack OAuth callback error:", err);
      res.status(500).send("Failed to connect Slack account. Please try again.");
    }
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

  const server = http.createServer(app);
  server.listen(port, () => {
    console.log(`OAuth callback server listening on port ${port}`);
  });

  return { expressApp: app, httpServer: server };
}
