const state = {
  config: null,
  completedExpanded: false,
  taskSections: {
    pending: false,
    in_progress: true,
    completed: false
  },
  tasks: {
    items: [],
    lastValidByFile: new Map(),
    lastSuccessAt: null,
    error: null,
    warnings: []
  },
  timers: {
    tasks: null
  }
};

const ui = {
  siteTitle: document.querySelector('#site-title'),
  teamSubtitle: document.querySelector('#team-subtitle'),
  globalLastSuccess: document.querySelector('#global-last-success'),
  pageVisibilityState: document.querySelector('#page-visibility-state'),
  summary: {
    total: document.querySelector('#summary-total'),
    pending: document.querySelector('#summary-pending'),
    inProgress: document.querySelector('#summary-in-progress'),
    completed: document.querySelector('#summary-completed'),
    blocked: document.querySelector('#summary-blocked'),
    completionRate: document.querySelector('#summary-completion-rate')
  },
  statusBanner: document.querySelector('#status-banner'),
  heartbeatBanner: document.querySelector('#heartbeat-banner'),
  heartbeatCount: document.querySelector('#heartbeat-count'),
  heartbeatCheckedAt: document.querySelector('#heartbeat-checked-at'),
  heartbeatBody: document.querySelector('#heartbeat-body'),
  filters: {
    assignee: document.querySelector('#assignee-filter'),
    priority: document.querySelector('#priority-filter')
  },
  refreshTasksButton: document.querySelector('#refresh-tasks-button'),
  taskErrorState: document.querySelector('#task-error-state'),
  taskEmptyState: document.querySelector('#task-empty-state'),
  counts: {
    pending: document.querySelector('#pending-count-badge'),
    inProgress: document.querySelector('#in-progress-count-badge'),
    completed: document.querySelector('#completed-count-badge')
  },
  columns: {
    pending: document.querySelector('#pending-list'),
    inProgress: document.querySelector('#in-progress-list'),
    completed: document.querySelector('#completed-list')
  },
  completedToggle: document.querySelector('#toggle-completed-button'),
  taskCardTemplate: document.querySelector('#task-card-template'),
  heartbeatItemTemplate: document.querySelector('#heartbeat-item-template'),
  toast: document.querySelector('#toast')
};

const STATUS_LABELS = {
  pending: '未着手',
  in_progress: '進行中',
  completed: '完了',
  blocked: 'ブロック中'
};

const PRIORITY_LABELS = {
  high: '優先度: 高',
  medium: '優先度: 中',
  low: '優先度: 低'
};

let toastTimer = null;

function cacheBust(url) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}t=${Date.now()}`;
}

async function fetchJson(url) {
  const response = await fetch(cacheBust(url), {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' }
  });

  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload.message || payload.error || '';
    } catch (_error) {
      detail = response.statusText;
    }
    throw new Error(`HTTP ${response.status}: ${detail}`.trim());
  }

  return response.json();
}

function getTimezone() {
  return state.config?.timezone || 'Asia/Tokyo';
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: getTimezone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date) + ' JST';
}

function isMobileViewport() {
  const breakpoint = state.config?.ui?.mobileBreakpoint || 768;
  return window.innerWidth < breakpoint;
}

function normalizeText(value, fallback = '-') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function parseScalar(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value === '[]') return [];
  if (/^-?\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseInlineArray(value) {
  const trimmed = value.trim();
  if (trimmed === '[]') return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map((part) => parseScalar(part));
}

function parseMarkdownTask(markdown, fileName) {
  const match = String(markdown).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { error: `${fileName}: YAML フロントマターが見つかりません。` };
  }

  const data = {};
  const lines = match[1].split(/\r?\n/);
  let currentArrayKey = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '    ');
    if (!line.trim() || /^\s*#/.test(line)) continue;

    if (/^\s*-\s+/.test(line) && currentArrayKey) {
      data[currentArrayKey].push(parseScalar(line.replace(/^\s*-\s+/, '')));
      continue;
    }

    currentArrayKey = null;
    const keyValue = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!keyValue) {
      return { error: `${fileName}: YAML の行を解釈できません。` };
    }

    const [, key, rawValue] = keyValue;
    if (!rawValue) {
      data[key] = [];
      currentArrayKey = key;
      continue;
    }

    const trimmed = rawValue.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      data[key] = parseInlineArray(trimmed);
      continue;
    }

    data[key] = parseScalar(trimmed);
  }

  const body = match[2].trim();
  const allowedStatuses = new Set(['pending', 'in_progress', 'completed', 'blocked']);
  const status = allowedStatuses.has(String(data.status || '').trim()) ? String(data.status).trim() : 'pending';
  const blockedBy = Array.isArray(data.blocked_by) ? data.blocked_by.map((item) => String(item)) : [];
  const isBlocked = status === 'blocked' || blockedBy.length > 0;
  const assignee = String(data.assigned_to ?? data.assignee ?? 'unassigned').trim() || 'unassigned';
  const deliverable = data.deliverable ? String(data.deliverable).trim() : '';

  return {
    error: null,
    value: {
      fileName,
      id: data.id ?? fileName,
      title: normalizeText(data.title, '(無題タスク)'),
      status,
      columnStatus: status === 'completed' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'pending',
      statusLabel: STATUS_LABELS[status] || status,
      assignee,
      priority: ['high', 'medium', 'low'].includes(String(data.priority || '').trim()) ? String(data.priority).trim() : 'low',
      updated: data.updated || null,
      created: data.created || null,
      deliverable,
      blockedBy,
      isBlocked,
      body,
      raw: data
    }
  };
}

function getAgentInfo(agentId) {
  return state.config?.agents?.[agentId] || {
    label: agentId,
    color: '#6b7280'
  };
}

function sortTasks(tasks) {
  return [...tasks].sort((left, right) => {
    const leftTime = left.updated ? new Date(left.updated).getTime() : 0;
    const rightTime = right.updated ? new Date(right.updated).getTime() : 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return String(left.title).localeCompare(String(right.title), 'ja');
  });
}

function setSectionMessage(element, tone, title, description) {
  element.dataset.tone = tone;
  element.replaceChildren();
  const titleEl = document.createElement('h3');
  titleEl.className = 'banner-title';
  titleEl.textContent = title;
  const descEl = document.createElement('p');
  descEl.className = 'banner-description';
  descEl.textContent = description;
  element.append(titleEl, descEl);
  element.classList.remove('hidden');
}

function clearSectionMessage(element) {
  element.classList.add('hidden');
  element.replaceChildren();
  delete element.dataset.tone;
}

function updateVisibilityState() {
  ui.pageVisibilityState.textContent = document.hidden ? 'paused' : 'active';
}

function updateGlobalLastSuccess() {
  ui.globalLastSuccess.textContent = state.tasks.lastSuccessAt
    ? formatDateTime(state.tasks.lastSuccessAt)
    : '未取得';
}

function setStatusBanner(tone, title, description) {
  ui.statusBanner.dataset.tone = tone;
  ui.statusBanner.replaceChildren();
  const titleEl = document.createElement('h2');
  titleEl.className = 'banner-title';
  titleEl.textContent = title;
  const descEl = document.createElement('p');
  descEl.className = 'banner-description';
  descEl.textContent = description;
  ui.statusBanner.append(titleEl, descEl);
  ui.statusBanner.classList.remove('banner-hidden');
}

function clearStatusBanner() {
  ui.statusBanner.classList.add('banner-hidden');
  ui.statusBanner.replaceChildren();
  delete ui.statusBanner.dataset.tone;
}

function refreshStatusBanner() {
  if (state.tasks.error) {
    setStatusBanner('error', 'タスク取得エラー', `${state.tasks.error}。前回の有効データを継続表示します。`);
    return;
  }

  if (state.tasks.warnings.length > 0) {
    setStatusBanner('warning', '一部タスクで読み取りエラー', `${state.tasks.warnings.length}件で前回有効データへフォールバックしました。`);
    return;
  }

  clearStatusBanner();
}

function showToast(message, tone = 'success') {
  ui.toast.textContent = message;
  ui.toast.dataset.tone = tone;
  ui.toast.classList.add('toast-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    ui.toast.classList.remove('toast-visible');
  }, 2400);
}

function getTaskCounts(tasks) {
  const counts = { total: tasks.length, pending: 0, inProgress: 0, completed: 0, blocked: 0 };
  for (const task of tasks) {
    if (task.columnStatus === 'pending') counts.pending += 1;
    if (task.columnStatus === 'in_progress') counts.inProgress += 1;
    if (task.columnStatus === 'completed') counts.completed += 1;
    if (task.isBlocked) counts.blocked += 1;
  }
  return counts;
}

function renderSummary() {
  const counts = getTaskCounts(state.tasks.items);
  const completionRate = counts.total > 0 ? Math.round((counts.completed / counts.total) * 100) : 0;

  ui.summary.total.textContent = String(counts.total);
  ui.summary.pending.textContent = String(counts.pending);
  ui.summary.inProgress.textContent = String(counts.inProgress);
  ui.summary.completed.textContent = String(counts.completed);
  ui.summary.blocked.textContent = String(counts.blocked);
  ui.summary.completionRate.textContent = `${completionRate}%`;
}

function fillAssigneeFilter() {
  const previous = ui.filters.assignee.value || 'all';
  ui.filters.assignee.replaceChildren();
  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = 'すべて';
  ui.filters.assignee.append(allOption);

  for (const [agentId, agent] of Object.entries(state.config?.agents || {})) {
    const option = document.createElement('option');
    option.value = agentId;
    option.textContent = agent.label || agentId;
    ui.filters.assignee.append(option);
  }

  ui.filters.assignee.value = [...ui.filters.assignee.options].some((option) => option.value === previous) ? previous : 'all';
}

function getFilteredTasks() {
  const assigneeFilter = ui.filters.assignee.value;
  const priorityFilter = ui.filters.priority.value;

  return state.tasks.items.filter((task) => {
    if (assigneeFilter !== 'all' && task.assignee !== assigneeFilter) return false;
    if (priorityFilter !== 'all' && task.priority !== priorityFilter) return false;
    return true;
  });
}

function renderTaskColumn(container, tasks) {
  container.replaceChildren();
  const sortedTasks = sortTasks(tasks);

  for (const task of sortedTasks) {
    const fragment = ui.taskCardTemplate.content.cloneNode(true);
    const card = fragment.querySelector('.task-card');
    const toggle = fragment.querySelector('.task-card-toggle');
    const detail = fragment.querySelector('.task-detail');
    const agentChip = fragment.querySelector('.agent-chip');
    const priorityChip = fragment.querySelector('.priority-chip');
    const title = fragment.querySelector('.task-title');
    const meta = fragment.querySelector('.task-meta');
    const body = fragment.querySelector('.task-body');
    const idElement = fragment.querySelector('.task-id');
    const updatedElement = fragment.querySelector('.task-updated');
    const statusElement = fragment.querySelector('.task-status');
    const blockedRow = fragment.querySelector('.blocked-row');
    const blockedBy = fragment.querySelector('.task-blocked-by');
    const deliverableRow = fragment.querySelector('.deliverable-row');
    const deliverableButton = fragment.querySelector('.deliverable-button');
    const deliverablePath = fragment.querySelector('.deliverable-path');

    const agent = getAgentInfo(task.assignee);
    card.dataset.priority = task.priority;
    if (task.isBlocked) card.classList.add('is-blocked');
    agentChip.textContent = agent.label || task.assignee;
    agentChip.style.setProperty('--agent-color', agent.color || '#6b7280');
    priorityChip.dataset.priority = task.priority;
    priorityChip.textContent = PRIORITY_LABELS[task.priority] || task.priority;
    title.textContent = task.title;
    meta.textContent = `${task.statusLabel} / updated: ${normalizeText(task.updated, '-')}`;
    idElement.textContent = String(task.id);
    updatedElement.textContent = normalizeText(task.updated, '-');
    statusElement.textContent = task.isBlocked ? 'ブロック中' : task.statusLabel;
    body.textContent = task.body || '詳細記述なし';

    if (task.isBlocked && task.blockedBy.length > 0) {
      blockedRow.classList.remove('hidden');
      blockedBy.textContent = task.blockedBy.join(', ');
    }

    if (task.deliverable) {
      deliverableRow.classList.remove('hidden');
      deliverablePath.textContent = task.deliverable;
      deliverableButton.addEventListener('click', (event) => {
        event.stopPropagation();
        handleCopyDeliverable(task.deliverable);
      });
    }

    toggle.addEventListener('click', () => {
      detail.classList.toggle('hidden');
    });

    container.append(fragment);
  }
}

function applyMobileSectionStates() {
  const mapping = [
    ['pending', ui.columns.pending],
    ['in_progress', ui.columns.inProgress],
    ['completed', ui.columns.completed]
  ];

  for (const [status, element] of mapping) {
    if (!isMobileViewport()) {
      element.classList.remove('hidden');
      continue;
    }
    const expanded = state.taskSections[status];
    element.classList.toggle('hidden', !expanded);
  }
}

function renderTasks() {
  const allTasks = state.tasks.items;
  const filteredTasks = getFilteredTasks();
  const completedPreviewCount = state.config?.ui?.completedPreviewCount || 8;

  renderSummary();

  if (state.tasks.error) {
    setSectionMessage(ui.taskErrorState, 'error', 'タスクの読み取りに失敗しました', `${state.tasks.error} / 最終正常取得: ${formatDateTime(state.tasks.lastSuccessAt)}`);
  } else if (state.tasks.warnings.length > 0) {
    setSectionMessage(ui.taskErrorState, 'error', '一部タスクで読み取りエラーが発生しました', `${state.tasks.warnings.join(' / ')}`);
  } else {
    clearSectionMessage(ui.taskErrorState);
  }

  if (allTasks.length === 0) {
    setSectionMessage(ui.taskEmptyState, 'empty', 'タスクファイルはまだありません', '読み取り自体は成功しています。shared/tasks/ に Markdown タスクを追加すると表示されます。');
  } else if (filteredTasks.length === 0) {
    setSectionMessage(ui.taskEmptyState, 'empty', '該当タスクはありません', '現在の担当・優先度フィルタに一致するタスクがありません。');
  } else {
    clearSectionMessage(ui.taskEmptyState);
  }

  const pendingTasks = filteredTasks.filter((task) => task.columnStatus === 'pending');
  const inProgressTasks = filteredTasks.filter((task) => task.columnStatus === 'in_progress');
  const completedTasks = filteredTasks.filter((task) => task.columnStatus === 'completed');
  const completedVisible = state.completedExpanded ? completedTasks : completedTasks.slice(0, completedPreviewCount);

  renderTaskColumn(ui.columns.pending, pendingTasks);
  renderTaskColumn(ui.columns.inProgress, inProgressTasks);
  renderTaskColumn(ui.columns.completed, completedVisible);

  ui.counts.pending.textContent = String(pendingTasks.length);
  ui.counts.inProgress.textContent = String(inProgressTasks.length);
  ui.counts.completed.textContent = String(completedTasks.length);
  ui.completedToggle.textContent = state.completedExpanded ? '折りたたむ' : 'すべて表示';
  ui.completedToggle.disabled = completedTasks.length <= completedPreviewCount;

  applyMobileSectionStates();
  renderHeartbeat();
  refreshStatusBanner();
  updateGlobalLastSuccess();
}

function renderHeartbeat() {
  const heartbeatTargets = sortTasks(
    state.tasks.items.filter((task) => task.status === 'pending' && task.assignee !== 'unassigned' && !task.isBlocked)
  );

  if (!(state.config?.heartbeat?.enabled) || heartbeatTargets.length === 0) {
    ui.heartbeatBanner.classList.add('heartbeat-hidden');
    ui.heartbeatBody.replaceChildren();
    return;
  }

  ui.heartbeatBanner.classList.remove('heartbeat-hidden');
  ui.heartbeatCount.textContent = `${heartbeatTargets.length}件`;
  ui.heartbeatCheckedAt.textContent = formatDateTime(state.tasks.lastSuccessAt);
  ui.heartbeatBody.replaceChildren();

  for (const task of heartbeatTargets) {
    const fragment = ui.heartbeatItemTemplate.content.cloneNode(true);
    const title = fragment.querySelector('.heartbeat-task-title');
    const meta = fragment.querySelector('.heartbeat-task-meta');
    const button = fragment.querySelector('.heartbeat-copy-button');
    const agent = getAgentInfo(task.assignee);
    const canCopyOnMobile = state.config?.ui?.showCopyButtonsOnMobile === true;
    const allowCopy = !isMobileViewport() || canCopyOnMobile;

    title.textContent = `${agent.label || task.assignee}: ${task.title}`;
    meta.textContent = `priority: ${task.priority} / updated: ${normalizeText(task.updated, '-')} / assigned_to: ${task.assignee}`;

    if (!allowCopy) {
      button.disabled = true;
      button.textContent = 'PCでコピーしてください';
    } else {
      button.addEventListener('click', () => handleCopyCommand(task.assignee));
    }

    ui.heartbeatBody.append(fragment);
  }
}

async function loadConfig() {
  const payload = await fetchJson('/api/config');
  state.config = payload.config;

  document.title = state.config?.siteTitle || document.title;
  ui.siteTitle.textContent = state.config?.siteTitle || 'エージェントチーム監視ダッシュボード';
  ui.teamSubtitle.textContent = `${state.config?.teamName || 'Agent Team'} / ${getTimezone()} 表示`;

  fillAssigneeFilter();
}

async function loadTasks() {
  try {
    const payload = await fetchJson('/api/tasks');
    const nextItems = [];
    const warnings = [];

    for (const file of payload.files || []) {
      const parsed = parseMarkdownTask(file.content, file.name);
      if (parsed.error) {
        warnings.push(parsed.error);
        if (state.tasks.lastValidByFile.has(file.name)) {
          nextItems.push(state.tasks.lastValidByFile.get(file.name));
        }
        continue;
      }

      const enriched = { ...parsed.value, updated: parsed.value.updated || file.modifiedAt || null };
      state.tasks.lastValidByFile.set(file.name, enriched);
      nextItems.push(enriched);
    }

    if (nextItems.length === 0 && (payload.files || []).length > 0 && state.tasks.lastValidByFile.size > 0) {
      warnings.push('全タスクのパースに失敗したため、前回有効データを表示しています。');
      state.tasks.items = [...state.tasks.lastValidByFile.values()];
    } else {
      state.tasks.items = nextItems;
    }

    state.tasks.lastSuccessAt = payload.generatedAt || new Date().toISOString();
    state.tasks.error = null;
    state.tasks.warnings = warnings;
  } catch (error) {
    state.tasks.error = error.message;
    state.tasks.warnings = [];
  }

  renderTasks();
}

function clearPolling() {
  if (state.timers.tasks) {
    clearInterval(state.timers.tasks);
    state.timers.tasks = null;
  }
}

function setupPolling() {
  clearPolling();
  if (document.hidden || !state.config) return;

  const taskInterval = (state.config.polling?.taskIntervalSec || 30) * 1000;
  state.timers.tasks = window.setInterval(() => {
    loadTasks();
  }, taskInterval);
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.append(textArea);
  textArea.focus();
  textArea.select();
  document.execCommand('copy');
  textArea.remove();
}

async function handleCopyCommand(agentId) {
  try {
    const payload = await fetchJson(`/api/start-command?agent=${encodeURIComponent(agentId)}`);
    await copyText(payload.command);
    showToast(`${getAgentInfo(agentId).label || agentId} の起動コマンドをコピーしました`, 'success');
  } catch (error) {
    showToast(`コピーに失敗しました: ${error.message}`, 'error');
  }
}

async function handleCopyDeliverable(value) {
  try {
    await copyText(value);
    showToast(`成果物パスをコピーしました: ${value}`, 'success');
  } catch (error) {
    showToast(`コピーに失敗しました: ${error.message}`, 'error');
  }
}

function bindTaskSectionToggle() {
  document.querySelectorAll('.kanban-column').forEach((column) => {
    const status = column.dataset.status;
    const header = column.querySelector('.column-header');
    if (!status || !header) return;

    header.style.cursor = 'pointer';
    header.tabIndex = 0;
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', String(state.taskSections[status]));

    const toggle = () => {
      if (!isMobileViewport()) return;
      state.taskSections[status] = !state.taskSections[status];
      header.setAttribute('aria-expanded', String(state.taskSections[status]));
      applyMobileSectionStates();
    };

    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
  });
}

function bindEvents() {
  ui.filters.assignee.addEventListener('change', renderTasks);
  ui.filters.priority.addEventListener('change', renderTasks);
  ui.refreshTasksButton.addEventListener('click', loadTasks);
  ui.completedToggle.addEventListener('click', () => {
    state.completedExpanded = !state.completedExpanded;
    renderTasks();
  });

  document.addEventListener('visibilitychange', () => {
    updateVisibilityState();
    setupPolling();
  });

  window.addEventListener('resize', () => {
    applyMobileSectionStates();
    renderHeartbeat();
  });
}

async function initialize() {
  updateVisibilityState();
  bindEvents();
  bindTaskSectionToggle();

  try {
    await loadConfig();
    await loadTasks();
    setupPolling();
  } catch (error) {
    setStatusBanner('error', '初期化に失敗しました', error.message);
  }
}

initialize();
