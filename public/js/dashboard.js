/* ================================================================
   GitBot — Dashboard Application
   Vanilla JS SPA: events, repos, rules, stats
   ================================================================ */

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  user: null,
  repos: [],
  rules: [],
  currentTab: 'overview',
  events: {
    items: [],
    page: 1,
    total: 0,
    repoFilter: '',
    typeFilter: '',
  },
};

// ─── Utilities ───────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.setAttribute('role', 'status');
  container.appendChild(toast);
  // Animate in
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 3500);
}

function formatRelativeTime(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.setAttribute('aria-hidden', 'false');
  modal.classList.add('modal-open');
  document.body.style.overflow = 'hidden';
  const firstFocusable = modal.querySelector('button, input, select, textarea, [tabindex="0"]');
  if (firstFocusable) firstFocusable.focus();
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.setAttribute('aria-hidden', 'true');
  modal.classList.remove('modal-open');
  document.body.style.overflow = '';
}

// ─── Tab Navigation ──────────────────────────────────────────────────────────

function switchTab(tab) {
  state.currentTab = tab;

  document.querySelectorAll('.nav-item').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active);
  });

  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tab}`);
  });

  // Load data on tab switch
  if (tab === 'overview') loadOverview();
  if (tab === 'repos') loadRepos();
  if (tab === 'events') loadEvents();
  if (tab === 'rules') loadRules();
}

// Expose globally for inline onclick
window.switchTab = switchTab;

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function initAuth() {
  const res = await fetch('/auth/me');
  const data = await res.json();
  if (!data.authenticated) {
    window.location.href = '/';
    return false;
  }
  state.user = data;

  // Populate user UI
  const login = escapeHtml(data.login);
  const avatar = escapeHtml(data.avatar || '');
  document.getElementById('user-login').textContent = data.login;
  const avatarEl = document.getElementById('user-avatar');
  if (avatarEl) { avatarEl.src = avatar; avatarEl.alt = login; }
  const avatarMobile = document.getElementById('user-avatar-mobile');
  if (avatarMobile) { avatarMobile.src = avatar; avatarMobile.alt = login; }

  return true;
}

// ─── Overview ─────────────────────────────────────────────────────────────────

async function loadOverview() {
  try {
    const [stats, { events }] = await Promise.all([
      apiFetch('/stats'),
      apiFetch('/events?limit=5'),
    ]);

    document.getElementById('stat-events-24h').textContent = stats.events_24h || '0';
    document.getElementById('stat-events-7d').textContent = stats.events_7d || '0';
    document.getElementById('stat-actions-success').textContent = stats.actions_success || '0';
    document.getElementById('stat-actions-failed').textContent = stats.actions_failed || '0';
    document.getElementById('stat-repos').textContent = stats.connected_repos || '0';
    document.getElementById('stat-rules').textContent = stats.active_rules || '0';

    // Event type breakdown bars
    renderEventTypeBars(stats.eventsByType || []);

    // Recent events preview
    renderEventsList(events, 'recent-events-list', true);
  } catch (err) {
    showToast(`Failed to load stats: ${err.message}`, 'error');
  }
}

function renderEventTypeBars(byType) {
  const container = document.getElementById('event-type-bars');
  if (!byType.length) {
    container.innerHTML = '<div class="empty-state">No events yet — connect a repository to get started.</div>';
    return;
  }
  const max = Math.max(...byType.map(r => parseInt(r.count, 10)));
  const colors = { issues: 'var(--issue-color)', pull_request: 'var(--pr-color)', push: 'var(--push-color)' };
  container.innerHTML = byType.map(row => {
    const count = parseInt(row.count, 10);
    const pct = max > 0 ? Math.round((count / max) * 100) : 0;
    const color = colors[row.event_type] || 'var(--brand)';
    const label = row.event_type === 'pull_request' ? 'Pull Requests' : row.event_type.charAt(0).toUpperCase() + row.event_type.slice(1);
    return `
      <div class="type-bar-row">
        <span class="type-bar-label">${escapeHtml(label)}</span>
        <div class="type-bar-track" role="progressbar" aria-valuenow="${count}" aria-valuemin="0" aria-valuemax="${max}" aria-label="${label}: ${count} events">
          <div class="type-bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <span class="type-bar-count">${count}</span>
      </div>`;
  }).join('');
}

// ─── Events ───────────────────────────────────────────────────────────────────

async function loadEvents(page = 1) {
  state.events.page = page;
  const { repoFilter, typeFilter } = state.events;

  const params = new URLSearchParams({ page, limit: 20 });
  if (repoFilter) params.set('repoId', repoFilter);

  try {
    const data = await apiFetch(`/events?${params}`);
    let events = data.events;

    // Client-side type filter (server doesn't support type filter directly)
    if (typeFilter) {
      events = events.filter(e => e.event_type === typeFilter);
    }

    state.events.items = events;
    state.events.total = data.total;

    renderEventsList(events, 'events-list', false);
    renderPagination(data.total, page, 20, 'events-pagination', loadEvents);
  } catch (err) {
    document.getElementById('events-list').innerHTML = `<div class="error-state">Failed to load events: ${escapeHtml(err.message)}</div>`;
  }
}

function getEventIcon(eventType, action) {
  if (eventType === 'issues') return action === 'opened' ? '🐛' : action === 'closed' ? '✅' : '🔔';
  if (eventType === 'pull_request') return action === 'opened' ? '🔀' : action === 'merged' ? '🎉' : '🔄';
  if (eventType === 'push') return '📦';
  return '🤖';
}

function getEventBadgeClass(eventType) {
  if (eventType === 'issues') return 'badge-issue';
  if (eventType === 'pull_request') return 'badge-pr';
  if (eventType === 'push') return 'badge-push';
  return 'badge-default';
}

function renderEventsList(events, containerId, compact) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!events || !events.length) {
    container.innerHTML = '<div class="empty-state">No events yet. Connect a repository and trigger some activity on GitHub.</div>';
    return;
  }

  container.innerHTML = events.map(ev => {
    const icon = getEventIcon(ev.event_type, ev.action);
    const badgeClass = getEventBadgeClass(ev.event_type);
    const title = ev.issue_title || ev.pr_title || (ev.pusher_name ? `Push by ${ev.pusher_name}` : ev.event_type);
    const statusClass = ev.processed ? (ev.processing_error ? 'status-error' : 'status-success') : 'status-pending';
    const statusLabel = ev.processed ? (ev.processing_error ? 'Error' : 'Processed') : 'Pending';
    const link = ev.github_url ? `<a href="${escapeHtml(ev.github_url)}" target="_blank" rel="noopener noreferrer" class="event-github-link" aria-label="View on GitHub">↗</a>` : '';

    return `
      <div class="event-row ${compact ? 'event-row-compact' : ''}" 
           role="button" tabindex="0" 
           onclick="openEventDetail(${ev.id})"
           onkeydown="if(event.key==='Enter'||event.key===' ')openEventDetail(${ev.id})"
           aria-label="View details for ${escapeHtml(title)}">
        <span class="event-icon" aria-hidden="true">${icon}</span>
        <div class="event-info">
          <div class="event-title">${escapeHtml(title)}</div>
          <div class="event-meta">
            <span class="badge ${badgeClass}">${escapeHtml(ev.event_type)}${ev.action ? ':' + escapeHtml(ev.action) : ''}</span>
            <span class="event-repo">${escapeHtml(ev.repo_full_name)}</span>
            <span class="event-time">${formatRelativeTime(ev.created_at)}</span>
          </div>
        </div>
        <div class="event-status">
          <span class="status-dot ${statusClass}" title="${statusLabel}" aria-label="${statusLabel}"></span>
          ${link}
        </div>
      </div>`;
  }).join('');
}

async function openEventDetail(eventId) {
  openModal('event-detail-modal');
  const body = document.getElementById('event-detail-body');
  body.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  try {
    const actions = await apiFetch(`/events/${eventId}/actions`);
    const event = state.events.items.find(e => e.id === eventId);

    body.innerHTML = `
      <div class="detail-section">
        <h3 class="detail-label">Event</h3>
        <div class="detail-meta">
          <span class="badge ${event ? getEventBadgeClass(event.event_type) : ''}">${event ? escapeHtml(event.event_type) + (event.action ? ':' + escapeHtml(event.action) : '') : 'Unknown'}</span>
          <span>${event ? escapeHtml(event.repo_full_name) : ''}</span>
          <span>${event ? formatRelativeTime(event.created_at) : ''}</span>
        </div>
        ${event && event.processing_error ? `<div class="error-banner">⚠️ Processing error: ${escapeHtml(event.processing_error)}</div>` : ''}
      </div>

      <div class="detail-section">
        <h3 class="detail-label">Bot Actions (${actions.length})</h3>
        ${actions.length === 0 ? '<div class="empty-state-sm">No actions taken for this event.</div>' : actions.map(a => {
          const statusClass = a.status === 'success' ? 'status-success' : a.status === 'failed' ? 'status-error' : 'status-pending';
          const details = typeof a.details === 'string' ? JSON.parse(a.details || '{}') : (a.details || {});
          return `
            <div class="action-row">
              <span class="status-dot ${statusClass}" aria-label="${escapeHtml(a.status)}"></span>
              <div class="action-info">
                <span class="action-type">${escapeHtml(a.action_type)}</span>
                ${a.status === 'failed' && a.error ? `<span class="action-error">Error: ${escapeHtml(a.error)}</span>` : ''}
                ${details && Object.keys(details).length ? `<pre class="action-details">${escapeHtml(JSON.stringify(details, null, 2))}</pre>` : ''}
              </div>
              <span class="action-retry">Retry ${a.retry_count}</span>
            </div>`;
        }).join('')}
      </div>`;
  } catch (err) {
    body.innerHTML = `<div class="error-state">Failed to load event details: ${escapeHtml(err.message)}</div>`;
  }
}

window.openEventDetail = openEventDetail;

function renderPagination(total, currentPage, limit, containerId, onPageChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const totalPages = Math.ceil(total / limit);
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 2) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== '…') {
      pages.push('…');
    }
  }

  container.innerHTML = pages.map(p => {
    if (p === '…') return '<span class="page-ellipsis">…</span>';
    return `<button class="page-btn ${p === currentPage ? 'page-btn-active' : ''}" 
      onclick="${onPageChange.name}(${p})" aria-label="Page ${p}" aria-current="${p === currentPage ? 'page' : 'false'}">${p}</button>`;
  }).join('');
}

// ─── Repositories ─────────────────────────────────────────────────────────────

async function loadRepos() {
  const container = document.getElementById('connected-repos-list');
  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  try {
    state.repos = await apiFetch('/repos');
    renderConnectedRepos();

    // Populate repo filters in events tab
    populateRepoFilters();
  } catch (err) {
    container.innerHTML = `<div class="error-state">Failed to load repos: ${escapeHtml(err.message)}</div>`;
  }
}

function renderConnectedRepos() {
  const container = document.getElementById('connected-repos-list');
  if (!state.repos.length) {
    container.innerHTML = '<div class="empty-state">No repositories connected yet. Click "Connect Repository" to get started.</div>';
    return;
  }

  container.innerHTML = state.repos.map(repo => `
    <div class="repo-row">
      <div class="repo-icon" aria-hidden="true">📁</div>
      <div class="repo-info">
        <div class="repo-name">${escapeHtml(repo.full_name)}</div>
        <div class="repo-meta">
          <span class="badge ${repo.active ? 'badge-success' : 'badge-muted'}">${repo.active ? 'Active' : 'Inactive'}</span>
          <span>${escapeHtml(String(repo.event_count || 0))} events</span>
          <span>Connected ${formatRelativeTime(repo.created_at)}</span>
        </div>
      </div>
      <button class="btn btn-sm btn-danger" 
        onclick="disconnectRepo(${repo.id}, '${escapeHtml(repo.full_name)}')"
        aria-label="Disconnect ${escapeHtml(repo.full_name)}">
        Disconnect
      </button>
    </div>`).join('');
}

async function disconnectRepo(repoId, fullName) {
  if (!confirm(`Disconnect ${fullName}? This will delete the GitHub webhook.`)) return;
  try {
    await apiFetch(`/repos/${repoId}`, { method: 'DELETE' });
    showToast(`Disconnected ${fullName}`, 'success');
    loadRepos();
  } catch (err) {
    showToast(`Failed to disconnect: ${err.message}`, 'error');
  }
}

window.disconnectRepo = disconnectRepo;

function populateRepoFilters() {
  const selects = ['events-repo-filter', 'rule-repo'];
  selects.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    // Preserve the first option
    const first = sel.options[0];
    sel.innerHTML = '';
    sel.appendChild(first);
    state.repos.forEach(repo => {
      const opt = document.createElement('option');
      opt.value = repo.id;
      opt.textContent = repo.full_name;
      sel.appendChild(opt);
    });
  });
}

// ─── Connect Repo Modal ───────────────────────────────────────────────────────

async function openConnectRepoModal() {
  openModal('connect-repo-modal');
  const list = document.getElementById('available-repos-list');
  list.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  try {
    const repos = await apiFetch('/repos/available');
    const connectedIds = new Set(state.repos.map(r => r.github_repo_id));
    const available = repos.filter(r => !connectedIds.has(r.id));

    if (!available.length) {
      list.innerHTML = '<div class="empty-state">All your repositories are already connected.</div>';
      return;
    }

    list.innerHTML = available.map(repo => `
      <div class="repo-option" role="option" tabindex="0"
           onclick="connectRepo(${repo.id}, '${escapeHtml(repo.full_name)}')"
           onkeydown="if(event.key==='Enter')connectRepo(${repo.id},'${escapeHtml(repo.full_name)}')"
           aria-label="Connect ${escapeHtml(repo.full_name)}">
        <div class="repo-option-name">${escapeHtml(repo.full_name)}</div>
        <div class="repo-option-meta">
          ${repo.private ? '<span class="badge badge-muted">Private</span>' : '<span class="badge badge-success">Public</span>'}
          ${repo.language ? `<span>${escapeHtml(repo.language)}</span>` : ''}
          ${repo.description ? `<span>${escapeHtml(repo.description.slice(0, 80))}</span>` : ''}
        </div>
      </div>`).join('');

    // Wire up search filter
    const searchInput = document.getElementById('repo-search');
    if (searchInput) {
      searchInput.oninput = () => {
        const q = searchInput.value.toLowerCase();
        list.querySelectorAll('.repo-option').forEach(el => {
          el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      };
    }
  } catch (err) {
    list.innerHTML = `<div class="error-state">Failed to load repos: ${escapeHtml(err.message)}</div>`;
  }
}

async function connectRepo(githubRepoId, fullName) {
  const list = document.getElementById('available-repos-list');
  // Optimistic UI: disable clicked row
  list.querySelectorAll('.repo-option').forEach(el => el.style.pointerEvents = 'none');

  try {
    await apiFetch('/repos', {
      method: 'POST',
      body: JSON.stringify({ fullName, githubRepoId }),
    });
    showToast(`Connected ${fullName} ✓`, 'success');
    closeModal('connect-repo-modal');
    loadRepos();
  } catch (err) {
    showToast(`Failed to connect: ${err.message}`, 'error');
    list.querySelectorAll('.repo-option').forEach(el => el.style.pointerEvents = '');
  }
}

window.connectRepo = connectRepo;

// ─── Rules ────────────────────────────────────────────────────────────────────

const RULE_TEMPLATES = {
  'bug-label': {
    name: 'Bug Issue Labeler',
    eventType: 'issues',
    conditions: [{ field: 'issue.title', operator: 'contains', value: 'bug' }],
    actions: [{ type: 'add_label', params: { label: 'bug' } }],
  },
  'ai-triage': {
    name: 'AI Triage (Gemini)',
    eventType: 'issues',
    conditions: [{ field: 'action', operator: 'equals', value: 'opened' }],
    actions: [{ type: 'ai_triage', params: { post_comment: true } }],
  },
  'pr-notify': {
    name: 'PR Slack Notifier',
    eventType: 'pull_request',
    conditions: [{ field: 'action', operator: 'equals', value: 'opened' }],
    actions: [{ type: 'slack_notify', params: {} }],
  },
  'push-notify': {
    name: 'Main Branch Push Monitor',
    eventType: 'push',
    conditions: [{ field: 'ref', operator: 'contains', value: 'refs/heads/main' }],
    actions: [{ type: 'slack_notify', params: {} }],
  },
};

async function loadRules() {
  const container = document.getElementById('rules-list');
  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  try {
    state.rules = await apiFetch('/rules');
    renderRulesList();
    populateRepoFilters();
  } catch (err) {
    container.innerHTML = `<div class="error-state">Failed to load rules: ${escapeHtml(err.message)}</div>`;
  }
}

function renderRulesList() {
  const container = document.getElementById('rules-list');
  if (!state.rules.length) {
    container.innerHTML = '<div class="empty-state">No rules yet. Use a template above or create your own.</div>';
    return;
  }

  container.innerHTML = state.rules.map(rule => {
    const scope = rule.repo_full_name || 'All repositories';
    const condCount = (rule.conditions || []).length;
    const actCount = (rule.actions || []).length;
    return `
      <div class="rule-row">
        <div class="rule-info">
          <div class="rule-name-row">
            <span class="rule-name">${escapeHtml(rule.name)}</span>
            <span class="toggle-switch" title="${rule.active ? 'Active' : 'Inactive'}">
              <input type="checkbox" id="rule-toggle-${rule.id}" class="toggle-input" 
                     ${rule.active ? 'checked' : ''} 
                     onchange="toggleRule(${rule.id}, this.checked)"
                     aria-label="Toggle rule ${escapeHtml(rule.name)}" />
              <label class="toggle-label" for="rule-toggle-${rule.id}"></label>
            </span>
          </div>
          <div class="rule-meta">
            <span class="badge badge-info">${escapeHtml(rule.event_type)}</span>
            <span>${escapeHtml(scope)}</span>
            <span>${condCount} condition${condCount !== 1 ? 's' : ''}</span>
            <span>${actCount} action${actCount !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div class="rule-actions">
          <button class="btn btn-sm btn-ghost" onclick="editRule(${rule.id})" aria-label="Edit ${escapeHtml(rule.name)}">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteRule(${rule.id}, '${escapeHtml(rule.name)}')" aria-label="Delete ${escapeHtml(rule.name)}">Delete</button>
        </div>
      </div>`;
  }).join('');
}

async function toggleRule(ruleId, active) {
  try {
    await apiFetch(`/rules/${ruleId}`, {
      method: 'PUT',
      body: JSON.stringify({ active }),
    });
    const rule = state.rules.find(r => r.id === ruleId);
    if (rule) rule.active = active;
    showToast(`Rule ${active ? 'activated' : 'deactivated'}`, 'success');
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
    loadRules(); // re-sync
  }
}

window.toggleRule = toggleRule;

async function deleteRule(ruleId, name) {
  if (!confirm(`Delete rule "${name}"?`)) return;
  try {
    await apiFetch(`/rules/${ruleId}`, { method: 'DELETE' });
    showToast(`Rule deleted`, 'success');
    state.rules = state.rules.filter(r => r.id !== ruleId);
    renderRulesList();
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
}

window.deleteRule = deleteRule;

// ─── Rule Form ─────────────────────────────────────────────────────────────────

let editingRuleId = null;
let ruleConditions = [];
let ruleActions = [];

function openCreateRuleModal(template = null) {
  editingRuleId = null;
  ruleConditions = [];
  ruleActions = [];

  document.getElementById('rule-modal-title').textContent = 'Create Rule';
  document.getElementById('rule-submit-btn').textContent = 'Create Rule';
  document.getElementById('rule-name').value = '';
  document.getElementById('rule-event-type').value = 'issues';

  if (template) {
    const t = RULE_TEMPLATES[template];
    if (t) {
      document.getElementById('rule-name').value = t.name;
      document.getElementById('rule-event-type').value = t.eventType;
      ruleConditions = [...(t.conditions || [])];
      ruleActions = [...(t.actions || [])];
    }
  }

  renderConditionsList();
  renderActionsList();
  populateRepoFilters();
  openModal('rule-modal');
}

function editRule(ruleId) {
  const rule = state.rules.find(r => r.id === ruleId);
  if (!rule) return;

  editingRuleId = ruleId;
  ruleConditions = [...(rule.conditions || [])];
  ruleActions = [...(rule.actions || [])];

  document.getElementById('rule-modal-title').textContent = 'Edit Rule';
  document.getElementById('rule-submit-btn').textContent = 'Save Changes';
  document.getElementById('rule-name').value = rule.name;
  document.getElementById('rule-event-type').value = rule.event_type;
  const repoSel = document.getElementById('rule-repo');
  if (repoSel && rule.repo_id) repoSel.value = rule.repo_id;

  renderConditionsList();
  renderActionsList();
  populateRepoFilters();
  openModal('rule-modal');
}

window.editRule = editRule;

function renderConditionsList() {
  const container = document.getElementById('conditions-list');
  if (!ruleConditions.length) {
    container.innerHTML = '<div class="empty-conditions">No conditions — matches all events of this type</div>';
    return;
  }
  container.innerHTML = ruleConditions.map((cond, i) => `
    <div class="condition-row">
      <input class="input input-sm" value="${escapeHtml(cond.field)}" placeholder="Field (e.g. issue.title)"
             onchange="updateCondition(${i},'field',this.value)" aria-label="Condition field" />
      <select class="select select-sm" onchange="updateCondition(${i},'operator',this.value)" aria-label="Condition operator">
        ${['contains','not_contains','equals','not_equals','starts_with','matches_regex'].map(op =>
          `<option value="${op}" ${cond.operator === op ? 'selected' : ''}>${op.replace(/_/g, ' ')}</option>`
        ).join('')}
      </select>
      <input class="input input-sm" value="${escapeHtml(cond.value)}" placeholder="Value"
             onchange="updateCondition(${i},'value',this.value)" aria-label="Condition value" />
      <button class="btn-icon" onclick="removeCondition(${i})" aria-label="Remove condition">✕</button>
    </div>`).join('');
}

window.updateCondition = (i, field, value) => { ruleConditions[i][field] = value; };
window.removeCondition = (i) => { ruleConditions.splice(i, 1); renderConditionsList(); };

function renderActionsList() {
  const container = document.getElementById('actions-list');
  if (!ruleActions.length) {
    container.innerHTML = '<div class="empty-actions">Add at least one action</div>';
    return;
  }
  container.innerHTML = ruleActions.map((act, i) => {
    let paramsHtml = '';
    if (act.type === 'add_label') {
      paramsHtml = `<input class="input input-sm" value="${escapeHtml(act.params?.label || '')}" placeholder="Label name (e.g. bug)"
                           onchange="updateActionParam(${i},'label',this.value)" aria-label="Label name" />`;
    } else if (act.type === 'post_comment') {
      paramsHtml = `<textarea class="input input-sm" rows="2" placeholder="Comment text (use {{issue.title}} for interpolation)"
                              onchange="updateActionParam(${i},'template',this.value)" aria-label="Comment template">${escapeHtml(act.params?.template || '')}</textarea>`;
    } else if (act.type === 'ai_triage') {
      paramsHtml = `<label class="checkbox-label"><input type="checkbox" ${act.params?.post_comment !== false ? 'checked' : ''} 
                     onchange="updateActionParam(${i},'post_comment',this.checked)" /> Post AI analysis as comment</label>`;
    }
    return `
      <div class="action-form-row">
        <select class="select select-sm" onchange="updateActionType(${i},this.value)" aria-label="Action type">
          ${[
            ['add_label','Add Label'],['post_comment','Post Comment'],
            ['slack_notify','Slack Notification'],['ai_triage','AI Triage (Gemini)']
          ].map(([v,l]) => `<option value="${v}" ${act.type === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        ${paramsHtml}
        <button class="btn-icon" onclick="removeAction(${i})" aria-label="Remove action">✕</button>
      </div>`;
  }).join('');
}

window.updateActionType = (i, type) => {
  ruleActions[i] = { type, params: {} };
  renderActionsList();
};
window.updateActionParam = (i, key, value) => {
  if (!ruleActions[i].params) ruleActions[i].params = {};
  ruleActions[i].params[key] = value;
};
window.removeAction = (i) => { ruleActions.splice(i, 1); renderActionsList(); };

async function submitRuleForm(e) {
  e.preventDefault();
  const name = document.getElementById('rule-name').value.trim();
  const eventType = document.getElementById('rule-event-type').value;
  const repoId = document.getElementById('rule-repo').value || null;

  if (!name) { showToast('Rule name is required', 'error'); return; }
  if (!ruleActions.length) { showToast('Add at least one action', 'error'); return; }

  const payload = { name, eventType, conditions: ruleConditions, actions: ruleActions, repoId: repoId ? parseInt(repoId) : null };
  const btn = document.getElementById('rule-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    if (editingRuleId) {
      await apiFetch(`/rules/${editingRuleId}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Rule updated ✓', 'success');
    } else {
      await apiFetch('/rules', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Rule created ✓', 'success');
    }
    closeModal('rule-modal');
    loadRules();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = editingRuleId ? 'Save Changes' : 'Create Rule';
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

function bindEventListeners() {
  // Sidebar nav tabs
  document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Mobile sidebar toggle
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  if (sidebarToggle && sidebar) {
    sidebarToggle.addEventListener('click', () => {
      const expanded = sidebarToggle.getAttribute('aria-expanded') === 'true';
      sidebarToggle.setAttribute('aria-expanded', !expanded);
      sidebar.classList.toggle('sidebar-open');
    });
  }

  // Close modals on overlay click or close button
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });
  document.querySelectorAll('[data-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.modal));
  });

  // Close modals on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.modal-open').forEach(m => closeModal(m.id));
    }
  });

  // Connect repo button
  document.getElementById('connect-repo-btn')?.addEventListener('click', openConnectRepoModal);

  // Create rule button
  document.getElementById('create-rule-btn')?.addEventListener('click', () => openCreateRuleModal());

  // Template cards
  document.querySelectorAll('.template-card[data-template]').forEach(card => {
    card.addEventListener('click', () => openCreateRuleModal(card.dataset.template));
  });

  // Add condition button
  document.getElementById('add-condition-btn')?.addEventListener('click', () => {
    ruleConditions.push({ field: 'issue.title', operator: 'contains', value: '' });
    renderConditionsList();
  });

  // Add action button
  document.getElementById('add-action-btn')?.addEventListener('click', () => {
    ruleActions.push({ type: 'add_label', params: {} });
    renderActionsList();
  });

  // Rule form submit
  document.getElementById('rule-form')?.addEventListener('submit', submitRuleForm);

  // Refresh events button
  document.getElementById('refresh-events-btn')?.addEventListener('click', () => loadEvents(state.events.page));

  // Event filters
  document.getElementById('events-repo-filter')?.addEventListener('change', e => {
    state.events.repoFilter = e.target.value;
    loadEvents(1);
  });
  document.getElementById('events-type-filter')?.addEventListener('change', e => {
    state.events.typeFilter = e.target.value;
    loadEvents(1);
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const ok = await initAuth();
  if (!ok) return;

  bindEventListeners();

  // Load initial data
  await Promise.allSettled([
    loadOverview(),
    loadRepos(),
  ]);

  // Auto-refresh overview every 30s
  setInterval(() => {
    if (state.currentTab === 'overview') loadOverview();
  }, 30000);
}

init();
