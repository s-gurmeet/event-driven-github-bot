# AI Notes — GitBot Development

This document outlines how AI tools were utilized during the design, implementation, and refinement of **GitBot**, covering tool usage, architectural decisions, failure recovery, and future considerations.

---

## 1. AI Tools & Work Distribution

- **Tools & Models Used**:
  - **Antigravity IDE** paired with **Claude Sonnet 4.6 (Thinking)** and **Gemini Flash**.
  - **Google Gemini 1.5 Flash** (via `@google/genai` inside the application runtime for automated issue/PR triage and categorization).
- **Division of Responsibilities**:
  - **Human (Architecture & Standards)**: Defined the end-to-end event flow, security invariants (HMAC raw body capture, timing-safe checks, delivery-id idempotency), database relational schema, and the strict frontend aesthetic standard (replacing default emoji tropes with a production-grade SVG design system).
  - **AI (Scaffolding & Implementation)**: Generated Express route handlers, PostgreSQL DDL migrations, GitHub API wrapper routines, Slack Block Kit payload formats, and SPA dashboard state transitions.

---

## 2. Key Architectural Decisions Made Independently

### A. Per-Repository Webhook Secret Isolation
Instead of using a single global webhook secret for the entire application, GitBot generates a distinct `crypto.randomBytes(32)` secret for every connected repository (`/webhooks/github/:repoId`).
- *Rationale*: If a single repository configuration or secret is compromised, other repositories and users remain secure.

### B. Two-Phase Ingestion & Delivery-ID Idempotency
GitHub automatically retries webhooks if an endpoint does not acknowledge within 10 seconds. In synchronous systems, downstream delays (e.g., LLM inference or GitHub API rate limits) cause repeated deliveries and duplicate comments/labels.
- *Rationale*: We immediately record GitHub’s `X-GitHub-Delivery` UUID into the PostgreSQL `events` table with a `UNIQUE` constraint, return HTTP 200 instantly, and defer rule evaluation and bot dispatches asynchronously via `setImmediate`. Duplicate webhook retries are cleanly discarded before executing duplicate actions.

### C. Graceful Degradation of LLM Inference
Gemini 1.5 Flash performs auto-triage (estimating issue severity, categorization, and drafting friendly initial responses).
- *Rationale*: AI should enhance, not compromise, core infrastructure. The rules engine wraps Gemini calls in defensive error boundaries. If the AI service times out, rate limits, or returns malformed JSON, GitBot gracefully continues evaluating and executing deterministic actions (such as static labels and Slack notifications).

---

## 3. The Hardest Bug & Wrong Turn

### The Bug: Webhook Signature Verification Failures from Express Body Parsing
- **What happened**: The AI initially placed standard `app.use(express.json())` at the top of `server.js` and wrote a webhook handler that verified signatures using `JSON.stringify(req.body)`.
- **How we caught it**: GitHub's webhook deliveries failed signature verification with `401 Unauthorized` during live testing, even though the secret matched. `JSON.stringify()` in Node.js does not guarantee property ordering or exact whitespace matching of the sender's original raw payload stream.
- **The fix**: We refactored body parsing to preserve the raw byte buffer directly during ingestion:
  ```js
  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));
  ```
  The webhook verification middleware then computes HMAC-SHA256 directly on `req.rawBody` and compares signatures using `crypto.timingSafeEqual` to prevent timing attacks.

### The UI Polish: Eliminating Amateur Emoji Clutter
- **What happened**: The initial AI-generated frontend relied on informal emojis (`⚡`, `🤖`, `🔐`, `⚠️`) across buttons, status badges, and toast popups.
- **How we caught it**: From a senior frontend perspective, excessive emojis detract from a credible, enterprise-grade developer tool (like Linear, Vercel, or GitHub).
- **The fix**: We built a centralized, lightweight SVG vector icon system (`SVG_PATHS` and `icon()` utility) in `dashboard.js` and `index.html`. Every emoji was replaced with crisp, accessible 16px/24px SVG icons matching dark glassmorphism styling tokens.

---

## 4. What We Would Add With More Time

1. **GitHub App Migration**: Transition from OAuth user tokens to a GitHub App with fine-grained repository permissions and JWT installation access tokens.
2. **Persistent Queueing (BullMQ + Redis)**: Replace in-memory `setImmediate` processing with a persistent message broker to support backoff retries, dead-letter queues (DLQ), and distributed worker scaling.
3. **Interactive Webhook Replay**: Enable engineers to replay past webhook events directly from the dashboard audit log to test new rule configurations against historical data.
