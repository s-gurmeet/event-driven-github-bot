const db = require('../db');
const github = require('./github');
const slack = require('./slack');
const ai = require('./ai');

/**
 * Evaluate a single rule's conditions against the event payload.
 */
function matchesConditions(conditions, payload, eventType, action) {
  if (!conditions || conditions.length === 0) return true;

  return conditions.every(condition => {
    const { field, operator, value } = condition;

    // Resolve nested fields like "issue.title", "pull_request.user.login"
    const actual = resolveField(field, { payload, eventType, action });

    switch (operator) {
      case 'contains':
        return String(actual || '').toLowerCase().includes(String(value).toLowerCase());
      case 'not_contains':
        return !String(actual || '').toLowerCase().includes(String(value).toLowerCase());
      case 'equals':
        return String(actual || '').toLowerCase() === String(value).toLowerCase();
      case 'not_equals':
        return String(actual || '').toLowerCase() !== String(value).toLowerCase();
      case 'starts_with':
        return String(actual || '').toLowerCase().startsWith(String(value).toLowerCase());
      case 'matches_regex':
        try {
          return new RegExp(value, 'i').test(String(actual || ''));
        } catch {
          return false;
        }
      default:
        return false;
    }
  });
}

function resolveField(field, context) {
  const { payload, eventType, action } = context;
  const parts = field.split('.');
  let obj = payload;
  for (const part of parts) {
    if (obj === null || obj === undefined) return undefined;
    obj = obj[part];
  }
  return obj;
}

/**
 * Process automation rules for a given event.
 * Returns an array of action results.
 */
async function processRules(event, repo) {
  const { id: eventId, repo_id: repoId, event_type: eventType, action, payload } = event;

  // Load matching rules (repo-specific + global user rules)
  const rulesResult = await db.query(
    `SELECT r.* FROM rules r
     JOIN repositories rep ON rep.user_id = r.user_id
     WHERE rep.id = $1
       AND r.active = TRUE
       AND r.event_type = $2
       AND (r.repo_id IS NULL OR r.repo_id = $1)
     ORDER BY r.created_at ASC`,
    [repoId, eventType]
  );

  const rules = rulesResult.rows;
  const results = [];

  for (const rule of rules) {
    const conditions = rule.conditions;
    const actions = rule.actions;

    if (!matchesConditions(conditions, payload, eventType, action)) {
      continue;
    }

    console.log(`[Rules] Rule "${rule.name}" matched for event ${eventId}`);

    // Execute each action defined in the rule
    for (const ruleAction of actions) {
      const actionResult = await executeAction(ruleAction, event, repo, rule);
      results.push(actionResult);
    }
  }

  return results;
}

/**
 * Execute a single bot action and record it in the database.
 */
async function executeAction(ruleAction, event, repo, rule) {
  const { type, params } = ruleAction;
  const { id: eventId, payload, event_type: eventType, action } = event;
  const [owner, repoName] = repo.full_name.split('/');

  // Record action as pending
  const insertResult = await db.query(
    `INSERT INTO bot_actions (event_id, action_type, details, status)
     VALUES ($1, $2, $3, 'pending') RETURNING id`,
    [eventId, type, JSON.stringify({ rule_name: rule?.name, params })]
  );
  const actionId = insertResult.rows[0].id;

  try {
    let result;
    const token = await github.getTokenForRepo(repo.id);
    const issueOrPRNumber = payload.issue?.number || payload.pull_request?.number;

    switch (type) {
      case 'add_label': {
        const labelName = params.label;
        if (token === 'demo_token') {
          result = { label: labelName, simulated: true };
        } else {
          await github.addLabel(token, owner, repoName, issueOrPRNumber, labelName);
          result = { label: labelName };
        }
        break;
      }

      case 'post_comment': {
        const body = interpolateTemplate(params.template || params.body, payload, eventType);
        if (token === 'demo_token') {
          result = { body: body.slice(0, 100), simulated: true };
        } else {
          await github.postComment(token, owner, repoName, issueOrPRNumber, body);
          result = { body: body.slice(0, 100) };
        }
        break;
      }

      case 'slack_notify': {
        const url = payload.issue?.html_url || payload.pull_request?.html_url;
        const title = payload.issue?.title || payload.pull_request?.title || `Push to ${payload.ref}`;
        const body = payload.issue?.body || payload.pull_request?.body || '';
        try {
          await slack.sendSlackNotification({
            title,
            repoFullName: repo.full_name,
            eventType,
            action,
            url,
            body,
          });
          result = { notified: true };
        } catch (slackErr) {
          result = { notified: false, note: slackErr.message };
        }
        break;
      }

      case 'ai_triage': {
        const title = payload.issue?.title || payload.pull_request?.title;
        const body = payload.issue?.body || payload.pull_request?.body;
        const analysis = await ai.analyzeIssueOrPR({
          title, body, eventType, repoFullName: repo.full_name
        });

        if (analysis) {
          // Apply the suggested label
          if (analysis.suggestedLabel && issueOrPRNumber && token !== 'demo_token') {
            await github.addLabel(token, owner, repoName, issueOrPRNumber, analysis.suggestedLabel);
          }

          // Post AI analysis as a comment
          if (params.post_comment !== false && issueOrPRNumber && token !== 'demo_token') {
            const comment = formatAIComment(analysis);
            await github.postComment(token, owner, repoName, issueOrPRNumber, comment);
          }

          // Send Slack notification with AI summary
          try {
            const url = payload.issue?.html_url || payload.pull_request?.html_url;
            await slack.sendSlackNotification({
              title: payload.issue?.title || payload.pull_request?.title,
              repoFullName: repo.full_name,
              eventType,
              action,
              url,
              aiSummary: analysis.summary,
              priority: analysis.priority,
              labels: [analysis.suggestedLabel],
            });
          } catch {}

          result = { analysis, simulated: token === 'demo_token' };
        } else {
          result = { analysis: null, note: 'AI unavailable, skipped' };
        }
        break;
      }

      default:
        throw new Error(`Unknown action type: ${type}`);
    }

    // Mark action as successful
    await db.query(
      `UPDATE bot_actions
       SET status = 'success', details = $1, completed_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(result), actionId]
    );

    return { actionId, type, status: 'success', result };
  } catch (err) {
    console.error(`[Rules] Action ${type} failed for event ${eventId}:`, err.message);

    // Mark action as failed, increment retry count
    await db.query(
      `UPDATE bot_actions
       SET status = 'failed', error = $1, retry_count = retry_count + 1, completed_at = NOW()
       WHERE id = $2`,
      [err.message, actionId]
    );

    return { actionId, type, status: 'failed', error: err.message };
  }
}

/**
 * Simple template interpolation: {{issue.title}}, {{sender.login}}, etc.
 */
function interpolateTemplate(template, payload, eventType) {
  if (!template) return '';
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const parts = key.trim().split('.');
    let val = payload;
    for (const part of parts) {
      val = val?.[part];
    }
    return val !== undefined ? String(val) : '';
  });
}

function formatAIComment(analysis) {
  const priorityEmojis = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
  const emoji = priorityEmojis[analysis.priority] || '⚪';

  return `## 🤖 Automated Triage Report

**Summary:** ${analysis.summary}

**Priority:** ${emoji} \`${analysis.priority.toUpperCase()}\`

**Suggested Label:** \`${analysis.suggestedLabel}\`

**Reasoning:** ${analysis.reasoning}

---
*This analysis was generated automatically by [GitHub Automation Bot](${process.env.APP_URL || ''}). Please review and adjust as needed.*`;
}

module.exports = { processRules, executeAction, matchesConditions };
