import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { Express } from "express";
import type { App as SlackApp } from "@slack/bolt";
import {
  getRunnerByToken,
  updateRunnerStatus,
  updateRunnerCwd,
  upsertRunnerDirectory,
  getRunnerDirectories,
} from "../db/runners.js";

interface ConnectedRunner {
  ws: WebSocket;
  runnerId: string;
  userId: string;
  teamId: string;
}

const connectedRunners = new Map<string, ConnectedRunner>();
const pendingTasks = new Map<string, { resolve: (result: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

let slackApp: SlackApp | null = null;

export function setupRunnerServer(httpServer: Server, expressApp: Express, slack: SlackApp) {
  slackApp = slack;

  const wss = new WebSocketServer({ server: httpServer, path: "/runner/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token) {
      ws.close(4001, "Missing token");
      return;
    }

    const runner = getRunnerByToken(token);
    if (!runner) {
      ws.close(4002, "Invalid token");
      return;
    }

    const conn: ConnectedRunner = { ws, runnerId: runner.id, userId: runner.user_id, teamId: runner.team_id };
    connectedRunners.set(runner.id, conn);
    updateRunnerStatus(runner.id, "connected");
    console.log(`[runner] Connected: ${runner.id} (user ${runner.user_id})`);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleRunnerMessage(conn, msg);
      } catch (err) {
        console.error("[runner] Bad message:", err);
      }
    });

    ws.on("close", () => {
      connectedRunners.delete(runner.id);
      updateRunnerStatus(runner.id, "disconnected");
      console.log(`[runner] Disconnected: ${runner.id}`);
    });

    ws.on("pong", () => {
      updateRunnerStatus(runner.id, "connected");
    });
  });

  // keepalive ping
  setInterval(() => {
    for (const [, conn] of connectedRunners) {
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
    }
  }, 30_000);

  // serve runner client files
  expressApp.get("/runner/client.mjs", (_req, res) => {
    res.type("application/javascript").send(getRunnerClientCode());
  });

  expressApp.get("/runner/install.sh", (req, res) => {
    const host = req.headers.host ?? "localhost:3001";
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const baseUrl = `${proto}://${host}`;
    res.type("text/plain").send(getInstallScript(baseUrl));
  });
}

function handleRunnerMessage(conn: ConnectedRunner, msg: any) {
  switch (msg.type) {
    case "register": {
      updateRunnerCwd(conn.runnerId, msg.cwd);
      console.log(`[runner] Registered CWD: ${msg.cwd}`);
      // only scan on first connect — skip if we already have directories stored
      const existingDirs = getRunnerDirectories(conn.runnerId);
      if (existingDirs.length > 0) {
        console.log(`[runner] Skipping scan — ${existingDirs.length} directories already stored`);
        break;
      }
      // trigger initial scan
      sendToRunner(conn.runnerId, {
        type: "task",
        taskId: `scan-${conn.runnerId}`,
        instruction: [
          "IMPORTANT: This is a READ-ONLY exploration. Do NOT modify any files.",
          "",
          "List all top-level directories in the current working directory.",
          "For each directory, quickly check for README.md, package.json, Cargo.toml, go.mod, or similar project files.",
          "",
          "Return a JSON array with this exact format:",
          "```json",
          '[{"name": "dir-name", "summary": "1-2 sentence description of what this project appears to be based on its files"}]',
          "```",
          "",
          "Only include directories that look like code projects (have source files, config, etc). Skip node_modules, .git, build output, etc.",
        ].join("\n"),
      });
      break;
    }

    case "task_result": {
      const pending = pendingTasks.get(msg.taskId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingTasks.delete(msg.taskId);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      }

      // handle initial scan result
      if (msg.taskId.startsWith("scan-") && msg.result && !msg.error) {
        handleScanResult(conn, msg.result);
      }
      break;
    }
  }
}

async function handleScanResult(conn: ConnectedRunner, result: string) {
  if (!slackApp) return;

  try {
    // extract JSON from the result
    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      console.error("[runner] Could not parse scan result");
      return;
    }

    const directories: { name: string; summary: string }[] = JSON.parse(jsonMatch[0]);

    // store raw scan results (descriptions will be filled in by user)
    for (const dir of directories) {
      upsertRunnerDirectory(conn.runnerId, dir.name, dir.name, dir.summary);
    }

    // DM the user in Slack asking about the directories
    const dirList = directories
      .map((d) => `• *${d.name}/* — ${d.summary}`)
      .join("\n");

    await slackApp.client.chat.postMessage({
      channel: conn.userId,
      text: [
        `Your runner is connected and scanned your workspace. I found these projects:\n`,
        dirList,
        `\nWhich of these are relevant to your work? Tell me what each one does in the context of your organization — I'll remember it for future explorations.`,
        `\n_You can also say "only cx and slack-workflows are relevant" and I'll ignore the rest._`,
      ].join("\n"),
    });
  } catch (err) {
    console.error("[runner] Scan result handling error:", err);
  }
}

export function sendTaskToRunner(
  userId: string,
  teamId: string,
  instruction: string,
  cwd?: string,
  timeoutMs = 5 * 60_000,
): Promise<string> {
  // find connected runner for this user
  for (const [, conn] of connectedRunners) {
    if (conn.userId === userId && conn.teamId === teamId && conn.ws.readyState === WebSocket.OPEN) {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingTasks.delete(taskId);
          reject(new Error("Runner task timed out"));
        }, timeoutMs);

        pendingTasks.set(taskId, { resolve, reject, timer });

        sendToRunner(conn.runnerId, {
          type: "task",
          taskId,
          instruction,
          ...(cwd ? { cwd } : {}),
        });
      });
    }
  }

  return Promise.reject(new Error("No connected runner found for this user. Set one up with /setup-daemon."));
}

export function isRunnerConnected(userId: string, teamId: string): boolean {
  for (const [, conn] of connectedRunners) {
    if (conn.userId === userId && conn.teamId === teamId && conn.ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

export function getConnectedRunnerDirectories(userId: string, teamId: string): { name: string; path: string; description: string | null }[] {
  for (const [, conn] of connectedRunners) {
    if (conn.userId === userId && conn.teamId === teamId) {
      return getRunnerDirectories(conn.runnerId);
    }
  }
  return [];
}

function sendToRunner(runnerId: string, msg: any) {
  const conn = connectedRunners.get(runnerId);
  if (conn?.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(msg));
  }
}

function getRunnerClientCode(): string {
  return `#!/usr/bin/env node
import { readFileSync } from "fs";
import { execFile } from "child_process";
import { resolve } from "path";
import { WebSocket } from "ws";

const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf-8"));

function resolveCwd(taskCwd) {
  if (!taskCwd) return config.cwd;
  // absolute path → use as-is; relative → resolve from runner root
  if (taskCwd.startsWith("/")) return taskCwd;
  return resolve(config.cwd, taskCwd);
}

function connect() {
  const wsUrl = config.server.replace(/^http/, "ws") + "/runner/ws?token=" + config.token;
  console.log("[workflowr-runner] Connecting to", config.server);
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log("[workflowr-runner] Connected. CWD:", config.cwd);
    ws.send(JSON.stringify({ type: "register", cwd: config.cwd }));
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "task") {
      const cwd = resolveCwd(msg.cwd);
      console.log("[workflowr-runner] Task received:", msg.taskId, "cwd:", cwd);
      execFile("claude", ["-p", "--dangerously-skip-permissions", "--output-format", "text", msg.instruction], {
        cwd,
        timeout: 5 * 60 * 1000,
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env },
      }, (err, stdout, stderr) => {
        const result = { type: "task_result", taskId: msg.taskId, result: stdout, error: err ? err.message : null };
        if (ws.readyState === 1) ws.send(JSON.stringify(result));
        console.log("[workflowr-runner] Task done:", msg.taskId, err ? "(error)" : "(ok)");
      });
    }
  });

  ws.on("close", () => {
    console.log("[workflowr-runner] Disconnected. Reconnecting in 5s...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (err) => {
    console.error("[workflowr-runner] Error:", err.message);
  });
}

connect();
`;
}

function getInstallScript(baseUrl: string): string {
  return `#!/bin/bash
set -e

echo "=== workflowr runner setup ==="
echo ""

# check prerequisites
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required. Install it first."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "Error: Node.js 18+ required (found v$NODE_VERSION)"
  exit 1
fi

if ! command -v claude &>/dev/null; then
  echo "Error: Claude Code CLI is required."
  echo "Install: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

# get pairing token
TOKEN="\${1:?Usage: install.sh <pairing-token>}"

# get working directory
read -p "Working directory [\$(pwd)]: " CWD < /dev/tty
CWD="\${CWD:-\$(pwd)}"
CWD=$(cd "$CWD" && pwd) # resolve to absolute path

if [ ! -d "$CWD" ]; then
  echo "Error: Directory $CWD does not exist"
  exit 1
fi

# install
INSTALL_DIR="$HOME/.workflowr"
mkdir -p "$INSTALL_DIR"

echo "Downloading runner..."
curl -fsSL ${baseUrl}/runner/client.mjs -o "$INSTALL_DIR/runner.mjs"

# save config
cat > "$INSTALL_DIR/config.json" <<CONF
{
  "token": "$TOKEN",
  "cwd": "$CWD",
  "server": "${baseUrl}"
}
CONF

# install ws dependency
cd "$INSTALL_DIR"
[ -f package.json ] || echo '{"type":"module"}' > package.json
npm install --save ws 2>/dev/null

# platform-specific service setup
if [[ "\$OSTYPE" == "darwin"* ]]; then
  PLIST_PATH="$HOME/Library/LaunchAgents/com.workflowr.runner.plist"
  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.workflowr.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which node)</string>
    <string>$INSTALL_DIR/runner.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>$CWD</string>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/runner.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/runner.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/.nvm/versions/node/$(node -v)/bin:$HOME/.n/bin</string>
  </dict>
</dict>
</plist>
PLIST
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
  echo ""
  echo "Runner installed as macOS launch agent (auto-starts on login)."

elif command -v systemctl &>/dev/null; then
  UNIT_PATH="$HOME/.config/systemd/user/workflowr-runner.service"
  mkdir -p "$(dirname "$UNIT_PATH")"
  cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=workflowr runner
After=network.target

[Service]
ExecStart=$(which node) $INSTALL_DIR/runner.mjs
WorkingDirectory=$CWD
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now workflowr-runner
  echo ""
  echo "Runner installed as systemd user service."
else
  echo ""
  echo "No service manager detected. Start the runner manually:"
  echo "  node $INSTALL_DIR/runner.mjs"
fi

echo ""
echo "Config: $INSTALL_DIR/config.json"
echo "Logs:   $INSTALL_DIR/runner.log"
echo ""
echo "Check Slack — workflowr will scan your workspace and ask about your projects."
`;
}
