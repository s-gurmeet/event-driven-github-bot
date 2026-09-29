const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const github = require('../services/github');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// All API routes require authentication
router.use(requireAuth);

// ─── Repositories ────────────────────────────────────────────────────────────

/**
 * List repositories available to connect (from GitHub).
 */
router.get('/repos/available', async (req, res) => {
  try {
    const userResult = await db.query('SELECT access_token FROM users WHERE id = $1', [req.session.userId]);
    const token = userResult.rows[0].access_token;
    const repos = await github.listUserRepos(token);
    const simplified = repos.map(r => ({
      id: r.id,
      full_name: r.full_name,
      private: r.private,
      description: r.description,
      language: r.language,
    }));
    res.json(simplified);
  } catch (err) {
    console.error('[API] List repos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * List connected repositories for the current user.
 */
router.get('/repos', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.id, r.full_name, r.active, r.github_repo_id, r.created_at,
              COUNT(DISTINCT e.id) AS event_count
       FROM repositories r
       LEFT JOIN events e ON e.repo_id = r.id
       WHERE r.user_id = $1
       GROUP BY r.id
       ORDER BY r.created_at DESC`,
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Connect a repository — register a webhook on GitHub.
 */
router.post('/repos', async (req, res) => {
  const { fullName, githubRepoId } = req.body;
  if (!fullName || !githubRepoId) {
    return res.status(400).json({ error: 'fullName and githubRepoId are required' });
  }

  const [owner, repoName] = fullName.split('/');
  if (!owner || !repoName) {
    return res.status(400).json({ error: 'Invalid repo full name format (expected owner/repo)' });
  }

  try {
    const userResult = await db.query('SELECT access_token FROM users WHERE id = $1', [req.session.userId]);
    const token = userResult.rows[0].access_token;

    // Generate a unique webhook secret for this repo
    const webhookSecret = crypto.randomBytes(32).toString('hex');

    // Insert repo record first to get the ID
    const repoInsert = await db.query(
      `INSERT INTO repositories (user_id, github_repo_id, full_name, webhook_secret)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, github_repo_id) DO UPDATE SET active = TRUE
       RETURNING id`,
      [req.session.userId, githubRepoId, fullName, webhookSecret]
    );
    const repoId = repoInsert.rows[0].id;

    // Register the webhook on GitHub
    const webhookUrl = `${process.env.APP_URL}/webhooks/github/${repoId}`;
    let webhookId;
    try {
      webhookId = await github.createWebhook(
        token, owner, repoName, webhookUrl, webhookSecret,
        ['issues', 'pull_request', 'push']
      );
    } catch (err) {
      // Roll back repo insert if webhook fails
      await db.query('DELETE FROM repositories WHERE id = $1', [repoId]);
      throw new Error(`Failed to create GitHub webhook: ${err.message}`);
    }

    // Store webhook ID for later deletion
    await db.query(
      'UPDATE repositories SET webhook_id = $1 WHERE id = $2',
      [webhookId, repoId]
    );

    console.log(`[API] Connected repo ${fullName} with webhook ${webhookId}`);
    res.json({ id: repoId, fullName, webhookId });
  } catch (err) {
    console.error('[API] Connect repo error:', err.message);
    res.status(err.message.includes('already exists') ? 409 : 500).json({ error: err.message });
  }
});

/**
 * Disconnect a repository — delete the GitHub webhook.
 */
router.delete('/repos/:repoId', async (req, res) => {
  const { repoId } = req.params;
  try {
    const repoResult = await db.query(
      `SELECT r.*, u.access_token FROM repositories r
       JOIN users u ON u.id = r.user_id
       WHERE r.id = $1 AND r.user_id = $2`,
      [repoId, req.session.userId]
    );

    if (!repoResult.rows.length) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    const repo = repoResult.rows[0];
    const [owner, repoName] = repo.full_name.split('/');

    if (repo.webhook_id) {
      await github.deleteWebhook(repo.access_token, owner, repoName, repo.webhook_id);
    }

    await db.query('UPDATE repositories SET active = FALSE WHERE id = $1', [repoId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[API] Disconnect repo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Events ──────────────────────────────────────────────────────────────────

/**
 * List recent events for the user's connected repositories.
 */
router.get('/events', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
  const offset = (page - 1) * limit;
  const repoId = req.query.repoId;

  try {
    const params = [req.session.userId, limit, offset];
    let repoFilter = '';
    if (repoId) {
      repoFilter = 'AND e.repo_id = $4';
      params.push(repoId);
    }

    const eventsResult = await db.query(
      `SELECT e.id, e.delivery_id, e.event_type, e.action, e.processed,
              e.processing_error, e.created_at, e.processed_at,
              r.full_name AS repo_full_name,
              e.payload->'issue'->>'title' AS issue_title,
              e.payload->'pull_request'->>'title' AS pr_title,
              e.payload->'pusher'->>'name' AS pusher_name,
              COALESCE(
                e.payload->'issue'->>'html_url',
                e.payload->'pull_request'->>'html_url'
              ) AS github_url
       FROM events e
       JOIN repositories r ON r.id = e.repo_id
       WHERE r.user_id = $1 ${repoFilter}
       ORDER BY e.created_at DESC
       LIMIT $2 OFFSET $3`,
      params
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM events e
       JOIN repositories r ON r.id = e.repo_id
       WHERE r.user_id = $1 ${repoFilter ? repoFilter.replace('$4', '$2') : ''}`,
      repoId ? [req.session.userId, repoId] : [req.session.userId]
    );

    res.json({
      events: eventsResult.rows,
      total: parseInt(countResult.rows[0].count, 10),
      page,
      limit,
    });
  } catch (err) {
    console.error('[API] List events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get bot actions for a specific event.
 */
router.get('/events/:eventId/actions', async (req, res) => {
  const { eventId } = req.params;
  try {
    // Verify event belongs to user
    const checkResult = await db.query(
      `SELECT e.id FROM events e
       JOIN repositories r ON r.id = e.repo_id
       WHERE e.id = $1 AND r.user_id = $2`,
      [eventId, req.session.userId]
    );
    if (!checkResult.rows.length) return res.status(404).json({ error: 'Event not found' });

    const actionsResult = await db.query(
      'SELECT * FROM bot_actions WHERE event_id = $1 ORDER BY created_at ASC',
      [eventId]
    );
    res.json(actionsResult.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Rules ───────────────────────────────────────────────────────────────────

/**
 * List automation rules for the current user.
 */
router.get('/rules', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.*, rep.full_name AS repo_full_name
       FROM rules r
       LEFT JOIN repositories rep ON rep.id = r.repo_id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Create a new automation rule.
 */
router.post('/rules', async (req, res) => {
  const { name, eventType, conditions, actions, repoId, active } = req.body;
  if (!name || !eventType || !actions?.length) {
    return res.status(400).json({ error: 'name, eventType, and actions are required' });
  }

  // Validate event types
  const validEventTypes = ['issues', 'pull_request', 'push'];
  if (!validEventTypes.includes(eventType)) {
    return res.status(400).json({ error: `eventType must be one of: ${validEventTypes.join(', ')}` });
  }

  // Validate that repoId belongs to user if provided
  if (repoId) {
    const repoCheck = await db.query(
      'SELECT id FROM repositories WHERE id = $1 AND user_id = $2',
      [repoId, req.session.userId]
    );
    if (!repoCheck.rows.length) return res.status(403).json({ error: 'Repository not found' });
  }

  try {
    const result = await db.query(
      `INSERT INTO rules (user_id, repo_id, name, event_type, conditions, actions, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.session.userId,
        repoId || null,
        name,
        eventType,
        JSON.stringify(conditions || []),
        JSON.stringify(actions),
        active !== false,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[API] Create rule error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Update an existing rule.
 */
router.put('/rules/:ruleId', async (req, res) => {
  const { ruleId } = req.params;
  const { name, eventType, conditions, actions, active } = req.body;

  try {
    const result = await db.query(
      `UPDATE rules
       SET name = COALESCE($1, name),
           event_type = COALESCE($2, event_type),
           conditions = COALESCE($3, conditions),
           actions = COALESCE($4, actions),
           active = COALESCE($5, active),
           updated_at = NOW()
       WHERE id = $6 AND user_id = $7
       RETURNING *`,
      [
        name,
        eventType,
        conditions ? JSON.stringify(conditions) : null,
        actions ? JSON.stringify(actions) : null,
        active,
        ruleId,
        req.session.userId,
      ]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Rule not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete a rule.
 */
router.delete('/rules/:ruleId', async (req, res) => {
  const { ruleId } = req.params;
  try {
    const result = await db.query(
      'DELETE FROM rules WHERE id = $1 AND user_id = $2 RETURNING id',
      [ruleId, req.session.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats ───────────────────────────────────────────────────────────────────

/**
 * Dashboard summary stats.
 */
router.get('/stats', async (req, res) => {
  try {
    const statsResult = await db.query(
      `SELECT
         COUNT(DISTINCT e.id) FILTER (WHERE e.created_at > NOW() - INTERVAL '24 hours') AS events_24h,
         COUNT(DISTINCT e.id) FILTER (WHERE e.created_at > NOW() - INTERVAL '7 days') AS events_7d,
         COUNT(DISTINCT ba.id) FILTER (WHERE ba.status = 'success') AS actions_success,
         COUNT(DISTINCT ba.id) FILTER (WHERE ba.status = 'failed') AS actions_failed,
         COUNT(DISTINCT r.id) AS connected_repos,
         COUNT(DISTINCT rl.id) AS active_rules
       FROM repositories r
       LEFT JOIN events e ON e.repo_id = r.id
       LEFT JOIN bot_actions ba ON ba.event_id = e.id
       LEFT JOIN rules rl ON rl.user_id = r.user_id AND rl.active = TRUE
       WHERE r.user_id = $1`,
      [req.session.userId]
    );

    const eventsByType = await db.query(
      `SELECT e.event_type, COUNT(*) AS count
       FROM events e
       JOIN repositories r ON r.id = e.repo_id
       WHERE r.user_id = $1 AND e.created_at > NOW() - INTERVAL '7 days'
       GROUP BY e.event_type`,
      [req.session.userId]
    );

    res.json({
      ...statsResult.rows[0],
      eventsByType: eventsByType.rows,
    });
  } catch (err) {
    console.error('[API] Stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
