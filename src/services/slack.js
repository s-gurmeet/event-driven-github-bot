const fetch = require('node-fetch');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

/**
 * Send a rich Slack notification with blocks layout.
 */
async function sendSlackNotification(notification) {
  if (!SLACK_WEBHOOK_URL) {
    console.warn('[Slack] SLACK_WEBHOOK_URL not configured, skipping notification');
    return { skipped: true };
  }

  const { title, repoFullName, eventType, action, url, body, aiSummary, priority, labels } = notification;

  // Pick icon based on event type
  const icons = {
    issues: action === 'opened' ? '🐛' : action === 'closed' ? '✅' : '🔔',
    pull_request: action === 'opened' ? '🔀' : action === 'merged' ? '🎉' : '🔄',
    push: '📦',
  };
  const icon = icons[eventType] || '🤖';

  // Priority color bar
  const priorityColors = {
    critical: '#ef4444',
    high: '#f97316',
    medium: '#eab308',
    low: '#22c55e',
  };
  const color = priorityColors[priority] || '#6366f1';

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${icon} ${title}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Repository:*\n\`${repoFullName}\`` },
        { type: 'mrkdwn', text: `*Event:*\n\`${eventType}:${action || 'n/a'}\`` },
        ...(priority ? [{ type: 'mrkdwn', text: `*AI Priority:*\n${priorityEmoji(priority)} ${priority.toUpperCase()}` }] : []),
        ...(labels?.length ? [{ type: 'mrkdwn', text: `*Labels:*\n${labels.map(l => `\`${l}\``).join(' ')}` }] : []),
      ],
    },
  ];

  if (aiSummary) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🤖 AI Summary:*\n${aiSummary}` },
    });
  } else if (body) {
    const truncated = body.length > 300 ? body.slice(0, 297) + '…' : body;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Description:*\n${truncated}` },
    });
  }

  if (url) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔗 View on GitHub', emoji: true },
          url,
          style: 'primary',
        },
      ],
    });
  }

  blocks.push({ type: 'divider' });

  const payload = {
    attachments: [
      {
        color,
        blocks,
        fallback: `${icon} ${title} in ${repoFullName}`,
      },
    ],
  };

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack webhook failed: ${res.status} ${text}`);
  }

  return { sent: true };
}

function priorityEmoji(priority) {
  const map = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
  return map[priority] || '⚪';
}

module.exports = { sendSlackNotification };
