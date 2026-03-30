import "dotenv/config";

function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

function optionalEnv(key: string): string | undefined {
  return process.env[key];
}

export const config = {
  slack: {
    botToken: env("SLACK_BOT_TOKEN"),
    signingSecret: env("SLACK_SIGNING_SECRET"),
    appToken: env("SLACK_APP_TOKEN"),
    clientId: optionalEnv("SLACK_CLIENT_ID"),
    clientSecret: optionalEnv("SLACK_CLIENT_SECRET"),
    redirectUri: optionalEnv("SLACK_REDIRECT_URI"),
  },
  github: {
    token: env("GITHUB_TOKEN"),
  },
  google: {
    clientId: optionalEnv("GOOGLE_CLIENT_ID"),
    clientSecret: optionalEnv("GOOGLE_CLIENT_SECRET"),
    redirectUri: optionalEnv("GOOGLE_REDIRECT_URI"),
  },
  ai: {
    model: optionalEnv("AI_MODEL") ?? "anthropic/claude-sonnet-4.6",
    supermemoryApiKey: optionalEnv("SUPERMEMORY_API_KEY"),
  },
  linear: {
    apiKey: optionalEnv("LINEAR_API_KEY"),
  },
  notion: {
    apiKey: optionalEnv("NOTION_API_KEY"),
  },
  redis: {
    url: optionalEnv("REDIS_URL") ?? "redis://localhost:6379",
  },
  oauthPort: parseInt(optionalEnv("OAUTH_PORT") ?? "3847", 10),
};
