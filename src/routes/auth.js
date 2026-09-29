const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const db = require('../db');
const github = require('../services/github');

const router = express.Router();

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const APP_URL = process.env.APP_URL;

/**
 * Initiate GitHub OAuth flow.
 * Generates a random state token to prevent CSRF.
 */
router.get('/github', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${APP_URL}/auth/github/callback`,
    scope: 'repo read:user user:email',
    state,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

/**
 * GitHub OAuth callback.
 * Exchanges code for access token, upserts user record.
 */
router.get('/github/callback', async (req, res) => {
  const { code, state } = req.query;

  // Verify state to prevent CSRF
  if (!state || state !== req.session.oauthState) {
    return res.status(400).send('Invalid OAuth state. Please try again.');
  }
  delete req.session.oauthState;

  if (!code) {
    return res.status(400).send('Missing authorization code.');
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${APP_URL}/auth/github/callback`,
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error || !tokenData.access_token) {
      console.error('[Auth] Token exchange failed:', tokenData.error_description);
      return res.status(400).send(`GitHub OAuth error: ${tokenData.error_description || 'Unknown error'}`);
    }

    const accessToken = tokenData.access_token;

    // Fetch user profile from GitHub
    const ghUser = await github.getAuthenticatedUser(accessToken);

    // Upsert user in database
    const upsertResult = await db.query(
      `INSERT INTO users (github_id, login, name, avatar_url, access_token)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (github_id) DO UPDATE SET
         login = EXCLUDED.login,
         name = EXCLUDED.name,
         avatar_url = EXCLUDED.avatar_url,
         access_token = EXCLUDED.access_token,
         updated_at = NOW()
       RETURNING id`,
      [ghUser.id, ghUser.login, ghUser.name, ghUser.avatar_url, accessToken]
    );

    const userId = upsertResult.rows[0].id;

    // Store session
    req.session.userId = userId;
    req.session.userLogin = ghUser.login;
    req.session.userAvatar = ghUser.avatar_url;

    // Redirect to intended destination or dashboard
    const returnTo = req.session.returnTo || '/dashboard';
    delete req.session.returnTo;

    res.redirect(returnTo);
  } catch (err) {
    console.error('[Auth] Callback error:', err);
    res.status(500).send('Authentication failed. Please try again.');
  }
});

/**
 * Sign out.
 */
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('[Auth] Session destroy error:', err);
    res.clearCookie('bot.sid');
    res.redirect('/');
  });
});

/**
 * Instant Demo mode — explore dashboard with sample data
 */
router.get('/demo', async (req, res) => {
  try {
    // Upsert demo user
    const userRes = await db.query(
      `INSERT INTO users (github_id, login, name, avatar_url, access_token)
       VALUES (99999999, 'demo-developer', 'Demo Developer', 'https://avatars.githubusercontent.com/u/9919?v=4', 'demo_token')
       ON CONFLICT (github_id) DO UPDATE SET
         login = EXCLUDED.login,
         name = EXCLUDED.name,
         avatar_url = EXCLUDED.avatar_url,
         updated_at = NOW()
       RETURNING id`,
      []
    );
    const userId = userRes.rows[0].id;
    req.session.userId = userId;
    req.session.userLogin = 'demo-developer';
    req.session.userAvatar = 'https://avatars.githubusercontent.com/u/9919?v=4';

    // Ensure sample repository exists
    const repoRes = await db.query(
      `INSERT INTO repositories (user_id, github_repo_id, full_name, webhook_secret, active)
       VALUES ($1, 1029384, 'octocat/spoon-knife', 'sample_secret_key_123', true)
       ON CONFLICT (user_id, github_repo_id) DO UPDATE SET active = true
       RETURNING id`,
      [userId]
    );
    const repoId = repoRes.rows[0].id;

    // Ensure sample rule exists
    const ruleCheck = await db.query('SELECT id FROM rules WHERE user_id = $1', [userId]);
    if (ruleCheck.rows.length === 0) {
      await db.query(
        `INSERT INTO rules (user_id, repo_id, name, event_type, conditions, actions, active)
         VALUES ($1, $2, 'Auto-triage bugs & notify Slack', 'issues', $3, $4, true)`,
        [
          userId,
          repoId,
          JSON.stringify([{ field: 'issue.title', operator: 'contains', value: 'bug' }]),
          JSON.stringify([
            { type: 'add_label', params: { label: 'bug' } },
            { type: 'slack_notify', params: {} },
            { type: 'ai_triage', params: {} }
          ])
        ]
      );
    }

    // Ensure sample events exist if empty
    const eventCheck = await db.query('SELECT id FROM events WHERE repo_id = $1', [repoId]);
    if (eventCheck.rows.length === 0) {
      const crypto = require('crypto');
      const ev1 = await db.query(
        `INSERT INTO events (repo_id, delivery_id, event_type, action, payload, processed, processed_at)
         VALUES ($1, $2, 'issues', 'opened', $3, true, NOW() - INTERVAL '15 minutes')
         RETURNING id`,
        [
          repoId,
          crypto.randomUUID(),
          JSON.stringify({
            action: 'opened',
            issue: {
              number: 42,
              title: 'Critical bug: authentication session drops on refresh',
              body: 'When refreshing the dashboard page, session is lost intermittently.',
              html_url: 'https://github.com/octocat/spoon-knife/issues/42',
              user: { login: 'sarah_dev' }
            },
            repository: { full_name: 'octocat/spoon-knife' }
          })
        ]
      );

      // Add actions for event 1
      await db.query(
        `INSERT INTO bot_actions (event_id, action_type, status, details)
         VALUES
         ($1, 'add_label', 'success', '{"label":"bug"}'),
         ($1, 'ai_triage', 'success', '{"priority":"high","suggestedLabel":"bug","summary":"Session persistence issue detected on client refresh."}'),
         ($1, 'slack_notify', 'success', '{"channel":"#github-alerts"}')`,
        [ev1.rows[0].id]
      );

      const ev2 = await db.query(
        `INSERT INTO events (repo_id, delivery_id, event_type, action, payload, processed, processed_at)
         VALUES ($1, $2, 'pull_request', 'opened', $3, true, NOW() - INTERVAL '45 minutes')
         RETURNING id`,
        [
          repoId,
          crypto.randomUUID(),
          JSON.stringify({
            action: 'opened',
            pull_request: {
              number: 43,
              title: 'feat: add dark mode glassmorphism theme and animations',
              body: 'Implements modern design system with glowing borders and micro-interactions.',
              html_url: 'https://github.com/octocat/spoon-knife/pull/43',
              user: { login: 'alex_frontend' }
            },
            repository: { full_name: 'octocat/spoon-knife' }
          })
        ]
      );

      await db.query(
        `INSERT INTO bot_actions (event_id, action_type, status, details)
         VALUES
         ($1, 'add_label', 'success', '{"label":"enhancement"}'),
         ($1, 'slack_notify', 'success', '{"channel":"#github-alerts"}')`,
        [ev2.rows[0].id]
      );
    }

    res.redirect('/dashboard');
  } catch (err) {
    console.error('[Auth] Demo login error:', err);
    res.status(500).send('Failed to initialize demo session');
  }
});

/**
 * Get current user (for frontend).
 */
router.get('/me', (req, res) => {
  if (!req.session?.userId) {
    return res.json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    userId: req.session.userId,
    login: req.session.userLogin,
    avatar: req.session.userAvatar,
  });
});

module.exports = router;
