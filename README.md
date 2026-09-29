# GitBot — Event-Driven GitHub Automation Bot

A full-stack web application that reacts to GitHub repository events with AI-powered triage, configurable rules, and Slack notifications.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com)

## What It Does

1. **Sign in with GitHub** — secure OAuth flow with CSRF protection
2. **Connect repositories** — registers a per-repo HMAC-signed webhook automatically
3. **Receives events** — issues, pull requests, pushes
4. **Processes rules** — your configured conditions trigger bot actions
5. **Writes back to GitHub** — adds labels, posts comments via GitHub API
6. **Notifies Slack** — rich Block Kit messages with AI summaries
7. **AI Triage (Gemini)** — suggests labels, priority, posts triage comments
8. **Live dashboard** — full event log, action history, rule builder

## Live Demo

- **URL**: `https://gitbot.onrender.com` *(set your own deployed URL here)*
- **Test repo**: Point webhooks at a throwaway repo and open an issue titled "Bug: login broken" to trigger the AI triage demo rule

## Local Development

### Prerequisites
- Node.js ≥ 18
- PostgreSQL database (free: [neon.tech](https://neon.tech))
- GitHub OAuth App
- Slack Incoming Webhook URL
- (Optional) Google Gemini API key

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/github-automation-bot.git
cd github-automation-bot
npm install
```

### 2. Set Up GitHub OAuth App

1. Go to [GitHub Developer Settings](https://github.com/settings/developers) → OAuth Apps → New OAuth App
2. **Homepage URL**: `http://localhost:3000`
3. **Authorization callback URL**: `http://localhost:3000/auth/github/callback`
4. Copy the Client ID and Client Secret

### 3. Set Up Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From Scratch
2. Add **Incoming Webhooks** feature → Activate → Add to Workspace → Pick channel
3. Copy the Webhook URL

### 4. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
APP_URL=http://localhost:3000
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
SESSION_SECRET=$(openssl rand -hex 32)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
GEMINI_API_KEY=your_gemini_key   # optional
NODE_ENV=development
```

### 5. Run

```bash
npm run dev
```

The app starts on [http://localhost:3000](http://localhost:3000).

> **Note**: For local development, GitHub webhooks can't reach localhost. Use [ngrok](https://ngrok.com) or [smee.io](https://smee.io) to expose your local server:
> ```bash
> npx smee -u https://smee.io/YOUR_CHANNEL -t http://localhost:3000/webhooks/github/YOUR_REPO_ID
> ```

### 6. Database Migration

The schema is applied automatically on startup. To run manually:
```bash
npm run db:migrate
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_CLIENT_ID` | ✅ | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | ✅ | GitHub OAuth App client secret |
| `APP_URL` | ✅ | Public URL of your app (no trailing slash) |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `SESSION_SECRET` | ✅ | Random 32-byte hex for session signing |
| `SLACK_WEBHOOK_URL` | ✅ | Slack Incoming Webhook URL |
| `GEMINI_API_KEY` | ➖ | Google Gemini API key (enables AI triage) |
| `NODE_ENV` | ➖ | `production` or `development` |
| `PORT` | ➖ | Server port (default: 3000) |

## Deployment (Render — Free Tier)

### 1. Create a Neon database

1. Sign up at [neon.tech](https://neon.tech) (free, no card)
2. Create a project → copy the connection string

### 2. Push to GitHub

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/github-automation-bot.git
git push -u origin main
```

### 3. Deploy on Render

1. Sign up at [render.com](https://render.com) (free, no card)
2. New → Web Service → Connect your repo
3. **Build Command**: `npm install`
4. **Start Command**: `npm start`
5. **Environment Variables**: Add all from `.env.example`

### 4. Update GitHub OAuth App

After getting your Render URL, update your GitHub OAuth App:
- **Homepage URL**: `https://your-app.onrender.com`
- **Authorization callback URL**: `https://your-app.onrender.com/auth/github/callback`

## Architecture

```
Browser ──── GET / ──────────────────────────────────────── Landing Page
         ──── GET /dashboard ──────────────────────────── Dashboard (auth required)
         ──── GET /auth/github ───────────────────────── GitHub OAuth
         ──── GET /auth/github/callback ──────────────── OAuth Callback
         ──── /api/* ─────────────────────────────────── REST API (auth required)

GitHub ──── POST /webhooks/github/:repoId ───────────── Webhook Endpoint
               │
               ├── Verify HMAC-SHA256 signature (per-repo secret)
               ├── Idempotency check (X-GitHub-Delivery ID)
               ├── Store event in PostgreSQL
               ├── Evaluate automation rules
               ├── Execute matching actions:
               │     ├── add_label ── GitHub API
               │     ├── post_comment ── GitHub API
               │     ├── slack_notify ── Slack Incoming Webhook
               │     └── ai_triage ── Gemini Flash → label + comment + Slack
               └── Record all action results (success/failure)
```

## Security

- **Webhook signatures**: Every webhook is verified with HMAC-SHA256 (per-repo secret, constant-time comparison)
- **Idempotency**: `X-GitHub-Delivery` IDs prevent duplicate processing
- **CSRF protection**: OAuth state parameter validated on callback
- **Session security**: HTTP-only cookies, `SameSite=lax`, signed with strong secret
- **No secret leakage**: Tokens server-side only, CSP blocks external scripts
- **Ownership checks**: All API endpoints verify resource belongs to authenticated user
- **Helmet**: Security headers on every response

## Automation Rules

Rules are configured in the dashboard UI with a visual builder:

**Conditions** (all must match):
- Field: issue title, body, PR title, sender login, action, push ref
- Operator: contains, not contains, equals, starts with, matches regex

**Actions** (executed in order):
- `add_label` — applies a label to the issue/PR
- `post_comment` — posts a comment (supports `{{issue.title}}` templates)
- `slack_notify` — sends a Slack notification
- `ai_triage` — runs Gemini AI → suggests label + priority, posts triage comment, notifies Slack

**Templates** (one-click setup):
- Bug Labeler, AI Triage Bot, PR Notifier, Push Monitor

## API Reference

```
GET  /api/repos/available    List GitHub repos available to connect
GET  /api/repos              List connected repos
POST /api/repos              Connect a repo (registers webhook)
DELETE /api/repos/:id        Disconnect a repo (deletes webhook)

GET  /api/events             List events (paginated, filterable)
GET  /api/events/:id/actions List bot actions for an event

GET  /api/rules              List automation rules
POST /api/rules              Create a rule
PUT  /api/rules/:id          Update a rule
DELETE /api/rules/:id        Delete a rule

GET  /api/stats              Dashboard summary stats
GET  /auth/me                Current session info
GET  /health                 Health check (DB connectivity)
```

## Tech Stack

- **Backend**: Node.js, Express
- **Database**: PostgreSQL (Neon free tier)
- **Auth**: GitHub OAuth 2.0
- **AI**: Google Gemini 1.5 Flash (free tier via AI Studio)
- **Notifications**: Slack Incoming Webhooks (Block Kit)
- **Frontend**: Vanilla HTML/CSS/JS
- **Hosting**: Render (free tier)

## AI Notes

See [`AI_NOTES.md`](./AI_NOTES.md) for how AI tools were used in building this project.
