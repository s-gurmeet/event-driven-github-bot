const fetch = require('node-fetch');
const db = require('../db');

const GITHUB_API = 'https://api.github.com';

/**
 * Make an authenticated request to the GitHub API.
 * Handles rate limiting with exponential backoff.
 */
async function githubRequest(token, method, path, body = null, attempt = 0) {
  const url = `${GITHUB_API}${path}`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GitHubAutomationBot/1.0',
  };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Handle rate limiting with exponential backoff (max 3 attempts)
  if (res.status === 429 || res.status === 403) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '60', 10);
    if (attempt < 2) {
      const wait = Math.min(retryAfter * 1000, (2 ** attempt) * 2000);
      console.warn(`[GitHub] Rate limited, waiting ${wait}ms (attempt ${attempt + 1})`);
      await new Promise(r => setTimeout(r, wait));
      return githubRequest(token, method, path, body, attempt + 1);
    }
  }

  if (!res.ok && res.status !== 422) {
    const text = await res.text();
    throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }

  const contentType = res.headers.get('content-type') || '';
  return contentType.includes('json') ? res.json() : res.text();
}

/**
 * Get the authenticated user's profile.
 */
async function getAuthenticatedUser(token) {
  return githubRequest(token, 'GET', '/user');
}

/**
 * List repositories the user has push access to (needed to register webhooks).
 */
async function listUserRepos(token) {
  const repos = [];
  let page = 1;
  while (true) {
    const batch = await githubRequest(
      token, 'GET',
      `/user/repos?type=owner&sort=updated&per_page=100&page=${page}`
    );
    if (!batch.length) break;
    repos.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return repos;
}

/**
 * Register a webhook on a repository.
 * Returns the webhook ID.
 */
async function createWebhook(token, owner, repo, webhookUrl, secret, events = ['issues', 'pull_request', 'push']) {
  const result = await githubRequest(token, 'POST', `/repos/${owner}/${repo}/hooks`, {
    name: 'web',
    active: true,
    events,
    config: {
      url: webhookUrl,
      content_type: 'json',
      secret,
      insecure_ssl: '0',
    },
  });
  return result.id;
}

/**
 * Delete a webhook from a repository.
 */
async function deleteWebhook(token, owner, repo, hookId) {
  try {
    await githubRequest(token, 'DELETE', `/repos/${owner}/${repo}/hooks/${hookId}`);
  } catch (err) {
    // 404 means already deleted — that's fine
    if (!err.message.includes('404')) throw err;
  }
}

/**
 * Add a label to an issue or PR.
 * Creates the label if it doesn't exist.
 */
async function addLabel(token, owner, repo, issueNumber, labelName, color = 'e11d48') {
  // Ensure label exists
  try {
    await githubRequest(token, 'GET', `/repos/${owner}/${repo}/labels/${encodeURIComponent(labelName)}`);
  } catch (err) {
    if (err.message.includes('404')) {
      await githubRequest(token, 'POST', `/repos/${owner}/${repo}/labels`, {
        name: labelName,
        color,
        description: 'Created by GitHub Automation Bot',
      });
    } else {
      throw err;
    }
  }

  return githubRequest(token, 'POST', `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    labels: [labelName],
  });
}

/**
 * Post a comment on an issue or PR.
 */
async function postComment(token, owner, repo, issueNumber, body) {
  return githubRequest(token, 'POST', `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    body,
  });
}

/**
 * Get user token for a given repository.
 */
async function getTokenForRepo(repoId) {
  const result = await db.query(
    `SELECT u.access_token FROM users u
     JOIN repositories r ON r.user_id = u.id
     WHERE r.id = $1`,
    [repoId]
  );
  if (!result.rows.length) throw new Error(`No user found for repo ${repoId}`);
  return result.rows[0].access_token;
}

module.exports = {
  getAuthenticatedUser,
  listUserRepos,
  createWebhook,
  deleteWebhook,
  addLabel,
  postComment,
  getTokenForRepo,
  githubRequest,
};
