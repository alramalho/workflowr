# slack-workflows

Slack bot ("workflowr") for the Chatarmin team. Built with @slack/bolt + Vercel AI SDK (Claude).

## Stack
- TypeScript, ts-node
- @slack/bolt for Slack events/commands
- Vercel AI SDK with Claude for agent responses
- better-sqlite3 for token storage
- Integrations: Linear, GitHub, Google Calendar (read-only), Supermemory

## Structure
- `src/agent/` - AI agent config & tool definitions
- `src/integrations/` - External service clients (Google, Linear, GitHub, Slack)
- `src/listeners/` - Slack event/command/action handlers
- `src/jobs/` - Scheduled tasks (weekly reports, meeting watcher)
- `src/db/` - SQLite schemas and token management

## Key behaviors
- Responds to DMs, mentions, and active threads
- Uses `shouldRespond()` (Gemini Flash) to gate replies in active threads without explicit mention
- Writable channels configured in `src/integrations/slack.ts` (`WRITABLE_CHANNELS`)
- Allowed users hardcoded in `src/listeners/events.ts` (`ALLOWED_USERS`)
- Google OAuth tokens stored in SQLite; auth via `/google-auth` command
