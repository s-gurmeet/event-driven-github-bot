// Landing Page — Interactive Pipeline Sandbox & Animations
(function () {
  'use strict';

  // Check authentication status to adjust navigation
  fetch('/auth/me')
    .then(r => r.json())
    .then(data => {
      if (data.authenticated) {
        document.querySelectorAll('a[href="/auth/github"]').forEach(btn => {
          btn.href = '/dashboard';
          btn.innerHTML = '<span>Open Dashboard →</span>';
        });
      }
    })
    .catch(() => {});

  const logContainer = document.getElementById('sandbox-logs');

  const scenarios = {
    issue: {
      btnId: 'btn-sim-issue',
      nodes: {
        webhook: 'HMAC Verified: 200 OK',
        ai: 'Priority: HIGH (Confidence: 98%)',
        rules: "Rule Matched: 'Auto-Triage Bugs'",
        dispatch: "Added 'bug' + Slack Alert"
      },
      logs: [
        { time: '09:42:01', badge: 'INGEST', class: 'badge-issue', text: 'GitHub webhook: issue.opened (#104: "Auth token drops on refresh")' },
        { time: '09:42:02', badge: 'AI INTEL', class: 'badge-ai', text: 'Gemini 1.5: Priority [HIGH], Category [Bug], Suggested Label: "bug"' },
        { time: '09:42:02', badge: 'RULE', class: 'badge-action', text: 'Evaluated rule: conditions met (issue.title contains "auth")' },
        { time: '09:42:03', badge: 'GITHUB', class: 'badge-action', text: 'POST /repos/octocat/web/issues/104/labels → Added "bug"' },
        { time: '09:42:03', badge: 'SLACK', class: 'badge-slack', text: 'POST hooks.slack.com → Block Kit card delivered to #dev-alerts' }
      ]
    },
    pr: {
      btnId: 'btn-sim-pr',
      nodes: {
        webhook: 'HMAC Verified: 200 OK',
        ai: 'Summary: "Refactors DB pool"',
        rules: "Rule Matched: 'PR Review Alert'",
        dispatch: "Added 'needs-review' + Slack"
      },
      logs: [
        { time: '10:15:20', badge: 'INGEST', class: 'badge-pr', text: 'GitHub webhook: pull_request.opened (#105: "feat: database connection pooling")' },
        { time: '10:15:21', badge: 'AI INTEL', class: 'badge-ai', text: 'Gemini 1.5: "Refactors pg client with 30s keep-alive to prevent stale drops."' },
        { time: '10:15:22', badge: 'GITHUB', class: 'badge-action', text: 'POST /comments → Posted AI architectural summary on PR #105' },
        { time: '10:15:22', badge: 'SLACK', class: 'badge-slack', text: 'Sent PR preview card with direct review link to #pr-reviews' }
      ]
    },
    push: {
      btnId: 'btn-sim-push',
      nodes: {
        webhook: 'HMAC Verified: 200 OK',
        ai: 'Commit analysis: 3 files changed',
        rules: "Rule Matched: 'Main Branch Watcher'",
        dispatch: "Notified Slack: #deployments"
      },
      logs: [
        { time: '11:02:44', badge: 'INGEST', class: 'badge-push', text: 'GitHub webhook: push to refs/heads/main (commit 4b89ef1 by @alex)' },
        { time: '11:02:45', badge: 'RULE', class: 'badge-action', text: 'Evaluated rule: condition met (ref equals "refs/heads/main")' },
        { time: '11:02:45', badge: 'SLACK', class: 'badge-slack', text: 'Broadcasted deploy alert to #deployments with commit diff' }
      ]
    }
  };

  window.simulateEvent = function (type) {
    const s = scenarios[type];
    if (!s) return;

    // Toggle button active states
    ['btn-sim-issue', 'btn-sim-pr', 'btn-sim-push'].forEach(id => {
      const b = document.getElementById(id);
      if (b) {
        if (id === s.btnId) {
          b.classList.add('active');
          b.style.borderColor = 'var(--brand)';
          b.style.color = '#fff';
        } else {
          b.classList.remove('active');
          b.style.borderColor = 'var(--border)';
          b.style.color = 'var(--text-secondary)';
        }
      }
    });

    // Update node details
    const nWebhook = document.getElementById('node-webhook-detail');
    const nAi = document.getElementById('node-ai-detail');
    const nRules = document.getElementById('node-rules-detail');
    const nDispatch = document.getElementById('node-dispatch-detail');

    if (nWebhook) nWebhook.textContent = s.nodes.webhook;
    if (nAi) nAi.textContent = s.nodes.ai;
    if (nRules) nRules.textContent = s.nodes.rules;
    if (nDispatch) nDispatch.textContent = s.nodes.dispatch;

    // Animate log lines
    if (!logContainer) return;
    logContainer.innerHTML = '';

    s.logs.forEach((item, idx) => {
      const line = document.createElement('div');
      line.className = 'log-line';
      line.style.opacity = '0';
      line.innerHTML = `
        <span class="log-time">${item.time}</span>
        <span class="log-badge ${item.class}">${item.badge}</span>
        <span class="log-text">${item.text}</span>
      `;
      logContainer.appendChild(line);

      setTimeout(() => {
        line.style.opacity = '1';
        line.style.transform = 'translateY(0)';
      }, idx * 120);
    });
  };

  window.copyDemoLogs = function () {
    if (!logContainer) return;
    const text = logContainer.innerText;
    navigator.clipboard.writeText(text).then(() => {
      alert('Simulation log copied to clipboard!');
    }).catch(() => {});
  };

  // Run default scenario on load
  simulateEvent('issue');

  // Smooth scroll
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', e => {
      const target = document.querySelector(link.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
})();
