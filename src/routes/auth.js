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
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
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
