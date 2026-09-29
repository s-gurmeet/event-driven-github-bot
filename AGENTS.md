# AGENTS.md — AI Context and Instructions for GitBot

## Project Overview

GitBot is an event-driven GitHub automation bot built with:
- **Backend**: Node.js + Express
- **Database**: PostgreSQL (Neon free tier)
- **Auth**: GitHub OAuth 2.0
- **AI**: Google Gemini 1.5 Flash
- **Frontend**: Vanilla HTML/CSS/JS (dark glassmorphism design)
- **Hosting**: Render (free tier)

## Repository Structure

```
server.js               Main Express server (entry point)
src/
  db/
    index.js            PostgreSQL pool + query wrapper
    schema.sql          Database schema (run via migrate.js)
    migrate.js          Schema migration runner
  routes/
    auth.js             GitHub OAuth routes (/auth/*)
    webhooks.js         Webhook endpoint (/webhooks/github/:repoId)
    api.js              REST API (/api/*)
  services/
    github.js           GitHub API client (labels, comments, webhook CRUD)
    slack.js            Slack Block Kit notification sender
    ai.js               Google Gemini AI analysis
    rules.js            Automation rules engine + action executor
  middleware/
    auth.js             requireAuth middleware
    webhook.js          HMAC-SHA256 webhook signature verification
public/
  index.html            Landing page
  dashboard.html        Main dashboard (auth-gated)
  css/style.css         Full design system (dark theme)
  js/
    landing.js          Landing page interactivity
    dashboard.js        Dashboard SPA logic
```

## Critical Design Decisions

### 1. Idempotency via delivery_id
Every GitHub webhook includes an `X-GitHub-Delivery` UUID header. This is stored as a UNIQUE constraint in the `events` table. If GitHub retries a delivery (it does this on timeout), we detect the duplicate and skip reprocessing. This is essential for reliability.

### 2. Per-repo webhook secrets
Each connected repository gets its own `crypto.randomBytes(32)` secret used for the GitHub webhook. This means even if one secret leaks, other repos aren't compromised. The webhook URL includes the database repo ID: `/webhooks/github/:repoId`.

### 3. Async webhook processing
The webhook endpoint immediately returns HTTP 200 and processes the event asynchronously via `setImmediate`. This prevents GitHub from retrying due to slow processing. The event is stored in DB before processing, so it survives crashes.

### 4. Graceful AI degradation
The Gemini AI service returns `null` on any error (API key missing, quota exceeded, network error, parse error). The rules engine continues without AI features. Never fails the whole pipeline.

### 5. Ownership enforcement
Every API endpoint verifies the requesting user owns the resource via JOINs against `user_id`. No IDOR vulnerabilities.

## Environment Variables Required

```
GITHUB_CLIENT_ID       GitHub OAuth App client ID
GITHUB_CLIENT_SECRET   GitHub OAuth App client secret
APP_URL                Public URL (for OAuth callback + webhook URL generation)
DATABASE_URL           PostgreSQL connection string
SESSION_SECRET         32-byte hex for session signing
SLACK_WEBHOOK_URL      Slack Incoming Webhook URL
GEMINI_API_KEY         (optional) Google Gemini API key
```

## Key Invariants to Preserve

1. **Never parse webhook body before signature verification** — raw body must be captured before JSON parsing
2. **Never expose tokens/secrets in API responses or logs**
3. **Always use `crypto.timingSafeEqual` for HMAC comparison** — prevents timing attacks
4. **Store events before processing** — durability: if the server crashes mid-processing, event can be reprocessed
5. **Bot actions are always recorded** in `bot_actions` table with success/failure status

## Database Schema Key Points

- `events.delivery_id` — UNIQUE, GitHub's `X-GitHub-Delivery` header
- `events.processed` — false until all rules have been evaluated
- `bot_actions.status` — pending → success/failed, with retry_count
- `repositories.webhook_secret` — per-repo, used for HMAC verification
- `rules.conditions` — JSONB array of `{field, operator, value}`
- `rules.actions` — JSONB array of `{type, params}`

## Webhook Event Flow

```
POST /webhooks/github/:repoId
  → webhookSignatureMiddleware (captures raw body, extracts headers)
  → HTTP 200 response immediately
  → setImmediate(processWebhook)
    → Load repo from DB, verify active
    → verifyWebhookSignature(rawBody, signature, repo.webhook_secret)
    → Parse JSON payload
    → Check events table for duplicate delivery_id
    → INSERT INTO events (processed=false)
    → processRules(event, repo)
      → Load matching active rules for user+repo+eventType
      → matchesConditions(conditions, payload, eventType, action)
      → executeAction(ruleAction, event, repo, rule)
        → INSERT INTO bot_actions (status=pending)
        → Execute action (github.addLabel / postComment / slack / ai)
        → UPDATE bot_actions SET status=success/failed
    → UPDATE events SET processed=true
```

## Common Patterns

### Making a GitHub API call
```js
const token = await github.getTokenForRepo(repo.id);
await github.addLabel(token, owner, repoName, issueNumber, labelName);
```

### Sending Slack notification
```js
await slack.sendSlackNotification({
  title, repoFullName, eventType, action, url,
  aiSummary, priority, labels
});
```

### Running AI analysis
```js
const analysis = await ai.analyzeIssueOrPR({ title, body, eventType, repoFullName });
// analysis may be null if Gemini unavailable
if (analysis) { /* use analysis.suggestedLabel, analysis.priority, analysis.summary */ }
```
