const state = {
  models: [],
  accounts: [],
  proxies: [],
  runtimeConfig: null,
  refreshTimer: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const el = {
  loginView: $('#loginView'),
  appView: $('#appView'),
  loginForm: $('#loginForm'),
  loginError: $('#loginError'),
  summary: $('#summary'),
  refreshAll: $('#refreshAll'),
  logout: $('#logout'),
  statTotal: $('#statTotal'),
  statActive: $('#statActive'),
  statReady: $('#statReady'),
  statInflight: $('#statInflight'),
  statPending: $('#statPending'),
  statQuota: $('#statQuota'),
  statProxies: $('#statProxies'),
  accounts: $('#accounts'),
  addBrowserAccount: $('#addBrowserAccount'),
  showManual: $('#showManual'),
  exportAccounts: $('#exportAccounts'),
  importAccounts: $('#importAccounts'),
  manualDialog: $('#manualDialog'),
  manualForm: $('#manualForm'),
  manualProxySelect: $('#manualProxySelect'),
  accountDialog: $('#accountDialog'),
  accountForm: $('#accountForm'),
  accountProxySelect: $('#accountProxySelect'),
  accountDetailSummary: $('#accountDetailSummary'),
  showProxyDialog: $('#showProxyDialog'),
  exportProxies: $('#exportProxies'),
  importProxies: $('#importProxies'),
  proxies: $('#proxies'),
  proxyDialog: $('#proxyDialog'),
  proxyForm: $('#proxyForm'),
  taskForm: $('#taskForm'),
  submitState: $('#submitState'),
  accountSelect: $('#accountSelect'),
  modelSelect: $('#modelSelect'),
  durationSelect: $('#durationSelect'),
  resolutionSelect: $('#resolutionSelect'),
  aspectSelect: $('#aspectSelect'),
  modelError: $('#modelError'),
  statusFilter: $('#statusFilter'),
  refreshTasks: $('#refreshTasks'),
  tasks: $('#tasks'),
  configForm: $('#configForm'),
  configState: $('#configState'),
  runtimeForm: $('#runtimeForm'),
  runtimeState: $('#runtimeState'),
  versionState: $('#versionState'),
  updateProject: $('#updateProject'),
  updateOutput: $('#updateOutput'),
  refreshLogs: $('#refreshLogs'),
  clearLogs: $('#clearLogs'),
  logDialog: $('#logDialog'),
  logDetail: $('#logDetail'),
  logs: $('#logs')
};

el.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.loginError.textContent = '';
  const body = Object.fromEntries(new FormData(el.loginForm));
  try {
    await fetchJson('/admin/login', jsonOptions('POST', body));
    await boot();
  } catch (err) {
    el.loginError.textContent = err.message;
  }
});

el.logout.addEventListener('click', async () => {
  await fetchJson('/admin/logout', { method: 'POST' });
  showLogin();
});

el.refreshAll.addEventListener('click', refreshAll);
el.refreshTasks.addEventListener('click', refreshTasks);
el.refreshLogs.addEventListener('click', refreshLogs);
el.clearLogs.addEventListener('click', clearLogs);
el.updateProject.addEventListener('click', updateProject);
el.statusFilter.addEventListener('change', refreshTasks);
el.modelSelect.addEventListener('change', syncModelFields);
el.showManual.addEventListener('click', () => el.manualDialog.showModal());
el.showProxyDialog.addEventListener('click', () => openProxyDialog());
for (const button of $$('[data-close-dialog]')) {
  button.addEventListener('click', () => button.closest('dialog')?.close());
}

for (const tab of $$('.tabs button')) {
  tab.addEventListener('click', () => {
    $$('.tabs button').forEach((button) => button.classList.toggle('active', button === tab));
    $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${tab.dataset.tab}`));
  });
}

el.addBrowserAccount.addEventListener('click', async () => {
  el.addBrowserAccount.disabled = true;
  try {
    await fetchJson('/api/accounts/login-browser', jsonOptions('POST', {}));
    await refreshAccounts();
  } finally {
    el.addBrowserAccount.disabled = false;
  }
});

el.manualForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(el.manualForm);
  const body = Object.fromEntries(form);
  body.isActive = form.get('isActive') === 'on';
  body.maxConcurrent = Number(body.maxConcurrent || 2);
  body.generationLimit = Number(body.generationLimit || 80);
  for (const key of ['requestTimeoutMs', 'uploadTimeoutMs', 'taskTimeoutMs', 'maxRetries']) {
    if (body[key] === '') delete body[key];
    else body[key] = Number(body[key]);
  }
  await fetchJson('/api/accounts/manual', jsonOptions('POST', body));
  el.manualDialog.close();
  el.manualForm.reset();
  el.manualForm.maxConcurrent.value = 2;
  el.manualForm.generationLimit.value = 80;
  await refreshAccounts();
});

el.accountForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = el.accountForm.id.value;
  if (!id) return;
  const body = accountFormBody();
  await fetchJson(`/api/accounts/${id}`, jsonOptions('PUT', body));
  el.accountDialog.close();
  await refreshAccounts();
});

el.accountForm.querySelector('[data-account-query-credits]').addEventListener('click', async () => {
  const id = el.accountForm.id.value;
  if (!id) return;
  const button = el.accountForm.querySelector('[data-account-query-credits]');
  button.disabled = true;
  button.textContent = '查询中';
  try {
    const { account } = await fetchJson(`/api/accounts/${id}/runway-credits`);
    await refreshAccounts();
    fillAccountForm(account.id);
  } catch (err) {
    alert(`Runway 额度查询失败：${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = '查询Runway额度';
  }
});

el.accountForm.querySelector('[data-account-refresh-jwt]').addEventListener('click', async () => {
  const id = el.accountForm.id.value;
  if (!id) return;
  const button = el.accountForm.querySelector('[data-account-refresh-jwt]');
  button.disabled = true;
  button.textContent = '刷新中';
  try {
    await fetchJson(`/api/accounts/${id}/refresh-jwt`, { method: 'POST' });
    await refreshAccounts();
    await fillAccountForm(id);
  } catch (err) {
    alert(`JWT刷新失败：${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = '刷新JWT';
  }
});

el.accountForm.querySelector('[data-account-open-login]').addEventListener('click', async () => {
  const id = el.accountForm.id.value;
  if (!id) return;
  await fetchJson(`/api/accounts/${id}/open-login`, { method: 'POST' });
  await refreshAccounts();
  await fillAccountForm(id);
});

el.accountForm.querySelector('[data-account-reset-quota]').addEventListener('click', async () => {
  const id = el.accountForm.id.value;
  if (!id) return;
  await fetchJson(`/api/accounts/${id}/reset-generation-usage`, { method: 'POST' });
  await refreshAccounts();
  await fillAccountForm(id);
});

el.accountForm.querySelector('[data-account-delete]').addEventListener('click', async () => {
  const id = el.accountForm.id.value;
  if (!id || !confirm('确认删除这个账号？任务记录会保留，但不再绑定该账号。')) return;
  await fetchJson(`/api/accounts/${id}`, { method: 'DELETE' });
  el.accountDialog.close();
  await refreshAccounts();
});

el.proxyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(el.proxyForm);
  const body = Object.fromEntries(form);
  body.isActive = form.get('isActive') === 'on';
  const id = body.id;
  delete body.id;
  await fetchJson(id ? `/api/proxies/${id}` : '/api/proxies', jsonOptions(id ? 'PUT' : 'POST', body));
  el.proxyDialog.close();
  await refreshProxies();
  await refreshAccounts();
});

el.exportProxies.addEventListener('click', async () => {
  const data = await fetchJson('/api/proxies/export');
  downloadJson(data, `runway-proxies-${Date.now()}.json`);
});

el.importProxies.addEventListener('change', async () => {
  await importJsonFile({
    input: el.importProxies,
    endpoint: '/api/proxies/import',
    label: '代理',
    refresh: async () => refreshProxies()
  });
});

el.exportAccounts.addEventListener('click', async () => {
  const data = await fetchJson('/api/accounts/export');
  downloadJson(data, `runway-accounts-${Date.now()}.json`);
});

el.importAccounts.addEventListener('change', async () => {
  await importJsonFile({
    input: el.importAccounts,
    endpoint: '/api/accounts/import',
    label: '账号',
    refresh: async () => refreshAccounts()
  });
});

el.taskForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.submitState.textContent = '正在入队...';
  const form = new FormData(el.taskForm);
  const files = form.getAll('media').filter((file) => file && file.size > 0);
  form.delete('media');
  for (const file of files) form.append('media[]', file);
  form.set('generateAudio', el.taskForm.generateAudio.checked ? 'true' : 'false');
  form.set('exploreMode', el.taskForm.exploreMode.checked ? 'true' : 'false');
  try {
    const result = await fetchJson('/v1/videos', { method: 'POST', body: form });
    el.submitState.textContent = `已入队 ${result.id.slice(0, 8)}`;
    el.taskForm.reset();
    syncModelFields();
    await refreshAll();
  } catch (err) {
    el.submitState.textContent = err.message;
  }
});

el.configForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(el.configForm));
  if (!body.password) delete body.password;
  const cfg = await fetchJson('/api/config', jsonOptions('PUT', body));
  fillConfig(cfg);
  el.configState.textContent = '已保存';
  window.setTimeout(() => (el.configState.textContent = ''), 1600);
});

el.runtimeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(el.runtimeForm);
  const body = Object.fromEntries(form);
  for (const key of ['requestTimeoutMs', 'uploadTimeoutMinMs', 'uploadTimeoutMaxMs', 'taskTimeoutMs', 'maxRetries', 'defaultGenerationLimit', 'queueLeaseTimeoutMs', 'staleTaskTimeoutMs', 'logRetentionDays', 'uploadRetentionDays']) {
    body[key] = Number(body[key]);
  }
  body.retryBackoffMs = String(body.retryBackoffMs || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
  body.forceProxy = form.get('forceProxy') === 'on';
  body.logRequestBody = form.get('logRequestBody') === 'on';
  body.logResponseBody = form.get('logResponseBody') === 'on';
  body.maskSecrets = form.get('maskSecrets') === 'on';
  const cfg = await fetchJson('/api/runtime-config', jsonOptions('PUT', body));
  fillRuntimeConfig(cfg);
  el.runtimeState.textContent = '已保存';
  window.setTimeout(() => (el.runtimeState.textContent = ''), 1600);
});

await boot();
state.refreshTimer = window.setInterval(() => {
  if (!el.appView.classList.contains('hidden')) refreshAll();
}, 10000);

async function boot() {
  const me = await fetchJson('/admin/me');
  if (!me.authenticated) {
    showLogin();
    return;
  }
  el.loginView.classList.add('hidden');
  el.appView.classList.remove('hidden');
  await refreshAll();
}

function showLogin() {
  el.loginView.classList.remove('hidden');
  el.appView.classList.add('hidden');
}

async function refreshAll() {
  await refreshModels();
  await Promise.all([refreshHealth(), refreshProxies(), refreshAccounts(), refreshTasks(), refreshConfig(), refreshRuntimeConfig(), refreshSystemVersion(), refreshLogs()]);
}

async function refreshHealth() {
  const health = await fetchJson('/health');
  const summary = health.accounts || {};
  el.statTotal.textContent = summary.total ?? 0;
  el.statActive.textContent = summary.active ?? 0;
  el.statReady.textContent = summary.ready ?? 0;
  el.statInflight.textContent = summary.inflight ?? 0;
  el.statPending.textContent = summary.pendingTasks ?? 0;
  el.statQuota.textContent = summary.generationRemaining ?? 0;
  el.statProxies.textContent = health.proxies?.active ?? 0;
  const authFailed = health.recentAuthFailures?.[0];
  el.summary.textContent = `浏览器 ${health.browser?.contexts || 0} 个账号窗口，可用账号 ${summary.ready ?? 0} 个，满并发 ${summary.fullConcurrency ?? 0} 个，满本地上限 ${summary.quotaExhausted ?? 0} 个，排队 ${health.queue?.pending ?? 0} 个，过期锁 ${health.queue?.stale ?? 0} 个${authFailed ? `，最近认证失败：${authFailed.name}` : ''}`;
}

async function refreshModels() {
  try {
    const { data } = await fetchJson('/v1/models');
    state.models = (data || []).map((model) => ({ ...model, label: model.name || model.id }));
    const current = el.modelSelect.value;
    el.modelSelect.innerHTML = state.models
      .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>`)
      .join('');
    if (current && state.models.some((model) => model.id === current)) el.modelSelect.value = current;
    syncModelFields();
    el.modelError.textContent = '';
  } catch (err) {
    el.modelError.textContent = `模型列表加载失败：${err.message}`;
  }
}

function syncModelFields() {
  const model = state.models.find((item) => item.id === el.modelSelect.value) || state.models[0];
  if (!model) return;
  fillSelect(el.durationSelect, model.durations, model.durations[0]);
  fillSelect(el.resolutionSelect, model.resolutions, model.resolutions[0]);
  fillSelect(el.aspectSelect, model.aspectRatios, model.aspectRatios[0]);
  el.taskForm.generateAudio.checked = Boolean(model.supportsAudio);
  el.taskForm.generateAudio.disabled = !model.supportsAudio;
  el.taskForm.exploreMode.checked = Boolean(model.supportsExploreMode);
  el.taskForm.exploreMode.disabled = !model.supportsExploreMode;
}

function fillSelect(select, values, fallback) {
  const current = select.value;
  select.innerHTML = values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  select.value = values.includes(current) ? current : fallback;
}

async function refreshAccounts() {
  const { accounts, summary } = await fetchJson('/api/accounts');
  state.accounts = accounts || [];
  renderAccounts(state.accounts);
  renderAccountSelect(state.accounts);
  if (summary) {
    el.statTotal.textContent = summary.total;
    el.statActive.textContent = summary.active;
    el.statReady.textContent = summary.ready;
    el.statInflight.textContent = summary.inflight;
    el.statPending.textContent = summary.pendingTasks;
  }
}

function renderAccountSelect(accounts) {
  const current = el.accountSelect.value;
  el.accountSelect.innerHTML = '<option value="auto">自动负载</option>' + accounts
    .map((account) => `<option value="${escapeAttr(account.id)}">${escapeHtml(account.name)}${account.ready ? '' : '（未就绪）'}</option>`)
    .join('');
  if (current && (current === 'auto' || accounts.some((account) => account.id === current))) el.accountSelect.value = current;
}

function renderManualProxySelect() {
  if (!el.manualProxySelect) return;
  const current = el.manualProxySelect.value;
  el.manualProxySelect.innerHTML = proxyOptions(current);
  if (current && state.proxies.some((proxy) => proxy.id === current)) el.manualProxySelect.value = current;
  if (el.accountProxySelect) {
    const selected = el.accountProxySelect.value;
    el.accountProxySelect.innerHTML = proxyOptions(selected);
    if (selected && state.proxies.some((proxy) => proxy.id === selected)) el.accountProxySelect.value = selected;
  }
}

function proxyOptions(selected = '') {
  return '<option value="">不绑定/自动</option>' + state.proxies
    .map((proxy) => `<option value="${escapeAttr(proxy.id)}" ${proxy.id === selected ? 'selected' : ''}>${escapeHtml(proxy.name)}${proxy.isActive ? '' : '（停用）'}</option>`)
    .join('');
}

function strategyOptions(selected = 'fixed') {
  return [
    ['fixed', '固定代理'],
    ['per_request', '每次轮换'],
    ['on_failure', '失败切换']
  ].map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function renderAccounts(accounts) {
  if (!accounts.length) {
    el.accounts.innerHTML = '<div class="empty">还没有账号，可以新增网页登录或手动添加。</div>';
    return;
  }
  el.accounts.innerHTML = `
    <div class="table-head accounts-head">
      <span>账号</span><span>状态</span><span>并发</span><span>本地生成数</span><span>Runway额度</span><span>代理</span><span>凭证</span><span>操作</span>
    </div>
    ${accounts.map((account) => `
      <div class="table-row accounts-row">
        <div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.remark || account.id)}</small></div>
        <span class="badge ${account.isActive ? 'completed' : 'failed'}">${account.isActive ? '启用' : '停用'}</span>
        <span>${account.inflight || 0}/${account.maxConcurrent || 2}</span>
        <div><strong>${account.generationUsed || 0}/${account.generationLimit || 80}</strong><small>剩余 ${account.generationRemaining ?? '-'}</small><small>每日自动刷新${account.generationResetAt ? ` · ${formatDate(account.generationResetAt)}` : ''}</small></div>
        <div class="credit-cell">${renderCreditSummary(account)}</div>
        <div><span>${escapeHtml(account.proxyName || '不绑定/自动')}</span><small>${escapeHtml(formatProxyStrategy(account.proxyStrategy))}</small></div>
        <div class="credential-cell">
          <span>${account.ready ? '完整' : '缺失'}</span>
          <small>JWT ${account.hasJwt ? '有' : '无'} / Cookie ${account.hasCookie ? '有' : '无'}</small>
          <small>team ${escapeHtml(account.teamId || '-')}</small>
          <small>错误 ${account.errorCount || 0}${account.lastAuthFailedAt ? ` / 认证失败 ${formatDate(account.lastAuthFailedAt)}` : ''}</small>
        </div>
        <div class="row-actions">
          <button type="button" data-account-detail="${escapeAttr(account.id)}">详情</button>
          <button type="button" data-open-login="${escapeAttr(account.id)}">网页登录</button>
          <button type="button" data-toggle="${escapeAttr(account.id)}" data-active="${account.isActive ? '1' : '0'}">${account.isActive ? '禁用' : '启用'}</button>
        </div>
      </div>
    `).join('')}
  `;
  bindAccountActions();
}

function bindAccountActions() {
  for (const button of $$('[data-account-detail]')) {
    button.addEventListener('click', async () => {
      await openAccountDialog(button.dataset.accountDetail);
    });
  }
  for (const button of $$('[data-open-login]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await fetchJson(`/api/accounts/${button.dataset.openLogin}/open-login`, { method: 'POST' });
        await refreshAccounts();
      } finally {
        button.disabled = false;
      }
    });
  }
  for (const button of $$('[data-toggle]')) {
    button.addEventListener('click', async () => {
      const action = button.dataset.active === '1' ? 'disable' : 'enable';
      await fetchJson(`/api/accounts/${button.dataset.toggle}/${action}`, { method: 'POST' });
      await refreshAccounts();
    });
  }
}

async function openAccountDialog(id) {
  await fillAccountForm(id);
  el.accountDialog.showModal();
}

async function fillAccountForm(id) {
  const { account } = await fetchJson(`/api/accounts/${id}`);
  state.accounts = state.accounts.map((item) => (item.id === account.id ? { ...item, ...withoutSecrets(account) } : item));
  const form = el.accountForm;
  form.reset();
  form.id.value = account.id;
  form.name.value = account.name || '';
  form.remark.value = account.remark || '';
  form.maxConcurrent.value = account.maxConcurrent || 2;
  form.generationLimit.value = account.generationLimit || 80;
  form.proxyId.innerHTML = proxyOptions(account.proxyId);
  form.proxyId.value = account.proxyId || '';
  form.proxyStrategy.value = account.proxyStrategy || 'fixed';
  form.authorization.value = account.jwt ? `Bearer ${account.jwt}` : '';
  form.cookie.value = account.cookieHeader || '';
  form.teamId.value = account.teamId || '';
  form.clientId.value = account.clientId || '';
  form.sourceVersion.value = account.sourceApplicationVersion || '';
  form.requestTimeoutMs.value = account.requestTimeoutMs || '';
  form.uploadTimeoutMs.value = account.uploadTimeoutMs || '';
  form.taskTimeoutMs.value = account.taskTimeoutMs || '';
  form.maxRetries.value = account.maxRetries ?? '';
  form.isActive.checked = Boolean(account.isActive);
  el.accountDetailSummary.innerHTML = accountDetailSummary(account);
}

function accountFormBody() {
  const form = new FormData(el.accountForm);
  const body = Object.fromEntries(form);
  body.isActive = form.get('isActive') === 'on';
  body.maxConcurrent = Number(body.maxConcurrent || 2);
  body.generationLimit = Number(body.generationLimit || 80);
  body.proxyId = body.proxyId || null;
  body.teamId = body.teamId ? Number(body.teamId) : null;
  for (const key of ['requestTimeoutMs', 'uploadTimeoutMs', 'taskTimeoutMs', 'maxRetries']) {
    if (body[key] === '') delete body[key];
    else body[key] = Number(body[key]);
  }
  if (!body.authorization) delete body.authorization;
  if (!body.cookie) delete body.cookie;
  return body;
}

function withoutSecrets(account) {
  const { jwt, cookieHeader, ...safe } = account;
  return safe;
}

function accountDetailSummary(account) {
  const rows = [
    ['账号ID', account.id],
    ['本地生成', `${account.generationUsed || 0}/${account.generationLimit || 80}，剩余 ${account.generationRemaining ?? '-'}`],
    ['生成刷新', `每日自动刷新${account.generationResetAt ? `，上次 ${formatDate(account.generationResetAt)}` : ''}`],
    ['Runway额度', creditSummaryText(account.runwayCredits)],
    ['额度查询', account.runwayCreditsCheckedAt ? formatDate(account.runwayCreditsCheckedAt) : '未查询'],
    ['凭证', `JWT ${account.hasJwt ? '有' : '无'} / Cookie ${account.hasCookie ? '有' : '无'}`],
    ['teamId', account.teamId || '-'],
    ['最近错误', account.lastError || '-']
  ];
  return rows.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
}

function renderCreditSummary(account) {
  const text = creditSummaryText(account.runwayCredits);
  const checked = account.runwayCreditsCheckedAt ? formatDate(account.runwayCreditsCheckedAt) : '未查询';
  return `<span>${escapeHtml(text)}</span><small>${escapeHtml(checked)}</small>`;
}

function creditSummaryText(credits = null) {
  if (!credits) return '未查询';
  const remaining = credits.remainingCredits ?? null;
  const used = credits.usedCredits ?? null;
  const plan = credits.planCredits ?? null;
  if (remaining != null && used != null) return `剩余 ${remaining} / 已用 ${used}`;
  if (remaining != null) return `剩余 ${remaining}`;
  if (plan != null) return `套餐 ${plan}`;
  return '已查询，未返回明确额度';
}

function formatProxyStrategy(strategy) {
  return {
    fixed: '固定代理',
    per_request: '每次轮换',
    on_failure: '失败切换'
  }[strategy] || '固定代理';
}

async function refreshProxies() {
  const { proxies } = await fetchJson('/api/proxies');
  state.proxies = proxies || [];
  renderProxies(state.proxies);
  renderManualProxySelect();
}

function renderProxies(proxies) {
  if (!proxies.length) {
    el.proxies.innerHTML = '<div class="empty">暂无代理。支持 http/https/socks5/socks5h、host:port、host:port:user:pass、st5 host:port:user:pass。</div>';
    return;
  }
  el.proxies.innerHTML = `
    <div class="table-head proxies-head"><span>代理</span><span>协议</span><span>状态</span><span>使用/错误</span><span>最近使用</span><span>操作</span></div>
    ${proxies.map((proxy) => `
      <div class="table-row proxies-row">
        <div><strong>${escapeHtml(proxy.name)}</strong><small>${escapeHtml(maskProxyUrl(proxy.url))}</small></div>
        <span>${escapeHtml(proxy.protocol || '-')}</span>
        <span class="badge ${proxy.isActive ? 'completed' : 'failed'}">${proxy.isActive ? '启用' : '停用'}</span>
        <span>${proxy.useCount || 0}/${proxy.errorCount || 0}</span>
        <span>${formatDate(proxy.lastUsedAt)}</span>
        <div class="row-actions">
          <button type="button" data-edit-proxy="${escapeAttr(proxy.id)}">编辑</button>
          <button type="button" data-test-proxy="${escapeAttr(proxy.id)}">测试</button>
          <button type="button" data-toggle-proxy="${escapeAttr(proxy.id)}" data-active="${proxy.isActive ? '1' : '0'}">${proxy.isActive ? '禁用' : '启用'}</button>
          <button type="button" data-delete-proxy="${escapeAttr(proxy.id)}">删除</button>
        </div>
      </div>
    `).join('')}
  `;
  bindProxyActions();
}

function bindProxyActions() {
  for (const button of $$('[data-edit-proxy]')) {
    button.addEventListener('click', () => {
      const proxy = state.proxies.find((item) => item.id === button.dataset.editProxy);
      openProxyDialog(proxy);
    });
  }
  for (const button of $$('[data-test-proxy]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = '测试中';
      try {
        await fetchJson(`/api/proxies/${button.dataset.testProxy}/test`, { method: 'POST' });
      } catch (err) {
        alert(`代理测试失败：${err.message}`);
      } finally {
        button.disabled = false;
        await refreshProxies();
      }
    });
  }
  for (const button of $$('[data-toggle-proxy]')) {
    button.addEventListener('click', async () => {
      const action = button.dataset.active === '1' ? 'disable' : 'enable';
      await fetchJson(`/api/proxies/${button.dataset.toggleProxy}/${action}`, { method: 'POST' });
      await refreshProxies();
    });
  }
  for (const button of $$('[data-delete-proxy]')) {
    button.addEventListener('click', async () => {
      if (!confirm('确认删除这个代理？绑定此代理的账号会自动取消绑定。')) return;
      await fetchJson(`/api/proxies/${button.dataset.deleteProxy}`, { method: 'DELETE' });
      await refreshProxies();
      await refreshAccounts();
    });
  }
}

function openProxyDialog(proxy = null) {
  el.proxyForm.reset();
  el.proxyForm.id.value = proxy?.id || '';
  el.proxyForm.name.value = proxy?.name || '';
  el.proxyForm.url.value = proxy?.url || '';
  el.proxyForm.isActive.checked = proxy ? proxy.isActive : true;
  el.proxyDialog.showModal();
}

async function refreshTasks() {
  const query = el.statusFilter.value ? `?status=${encodeURIComponent(el.statusFilter.value)}` : '';
  const { data } = await fetchJson(`/v1/videos${query}`);
  renderTasks((data || []).map(fromV1Video));
}

function renderTasks(tasks) {
  if (!tasks.length) {
    el.tasks.innerHTML = '<div class="empty">还没有任务。</div>';
    return;
  }
  el.tasks.innerHTML = `
    <div class="table-head tasks-head">
      <span>任务</span><span>账号</span><span>状态</span><span>进度</span><span>失败原因/结果</span><span>操作</span>
    </div>
    ${tasks.map((task) => `
      <div class="table-row tasks-row">
        <div><strong title="${escapeAttr(task.prompt)}">${escapeHtml(task.prompt)}</strong><small>${escapeHtml(task.id)}</small></div>
        <span>${escapeHtml(task.accountName || task.accountId || '自动')}</span>
        <span class="badge ${escapeAttr(task.status)}">${escapeHtml(formatStatus(task.status))}</span>
        <span>${task.progress == null ? '-' : `${task.progress}%`}</span>
        ${renderTaskResult(task)}
        <span class="row-actions">${canCancelTask(task) ? `<button type="button" data-cancel-task="${escapeAttr(task.id)}">取消</button>` : ''}${task.status === 'failed' ? `<button type="button" data-retry="${escapeAttr(task.id)}">重试</button>` : ''}<button type="button" data-task-detail="${escapeAttr(task.id)}">详情</button></span>
      </div>
    `).join('')}
  `;
  for (const button of $$('[data-retry]')) {
    button.addEventListener('click', async () => {
      await fetchJson(`/v1/videos/${button.dataset.retry}/retry`, { method: 'POST' });
      await refreshTasks();
    });
  }
  for (const button of $$('[data-cancel-task]')) {
    button.addEventListener('click', async () => {
      if (!confirm('确认取消这个任务？已提交到 Runway 的任务会尝试同步取消。')) return;
      button.disabled = true;
      button.textContent = '取消中';
      await fetchJson(`/v1/videos/${button.dataset.cancelTask}/cancel`, { method: 'POST' });
      await refreshTasks();
    });
  }
  for (const button of $$('[data-task-detail]')) {
    button.addEventListener('click', async () => {
      const task = await fetchJson(`/v1/videos/${button.dataset.taskDetail}`);
      const { data: events } = await fetchJson(`/v1/videos/${button.dataset.taskDetail}/events`);
      el.logDetail.textContent = JSON.stringify({ task, events }, null, 2);
      el.logDialog.showModal();
    });
  }
  for (const button of $$('[data-open-video]')) {
    button.addEventListener('click', async () => {
      const tab = window.open('about:blank', '_blank');
      try {
        button.disabled = true;
        button.textContent = '获取链接';
        const video = await fetchJson(`/v1/videos/${button.dataset.openVideo}`);
        if (!video.video_url) throw new Error('任务还没有可用的视频链接。');
        if (tab) {
          tab.location.href = video.video_url;
        } else {
          window.location.href = video.video_url;
        }
      } catch (err) {
        if (tab) tab.close();
        alert(err.message || '获取视频链接失败');
      } finally {
        button.disabled = false;
        button.textContent = '打开视频';
      }
    });
  }
}

function canCancelTask(task) {
  return ['pending', 'submitting', 'queuing', 'generating'].includes(task.status);
}

function renderTaskResult(task) {
  if (task.videoUrl) {
    return `<button type="button" data-open-video="${escapeAttr(task.id)}">打开视频</button>`;
  }
  const raw = task.rawStatus ? ` / ${task.rawStatus}` : '';
  const text = task.status === 'failed'
    ? `${task.errorSummary || task.errorCode || '任务失败'}${raw}`
    : (task.runwayTaskId || task.rawStatus || '-');
  const title = task.status === 'failed'
    ? [
        task.errorSummary,
        task.errorCode,
        task.errorCategory,
        task.errorMessage,
        task.errorReason,
        task.error?.message,
        task.error?.reason,
        task.error?.runway_message
      ].filter(Boolean).join('\n')
    : text;
  return `<span title="${escapeAttr(title)}">${escapeHtml(text)}</span>`;
}

function fromV1Video(video) {
  return {
    id: video.id,
    parentTaskId: video.metadata?.parent_task_id,
    accountId: video.account_id,
    accountName: video.account_name,
    runwayTaskId: video.runway_task_id,
    status: fromV1Status(video.status),
    rawStatus: video.metadata?.raw_status,
    signedUrlRefreshError: video.metadata?.signed_url_refresh_error,
    prompt: video.metadata?.prompt || '',
    model: video.model,
    duration: video.metadata?.duration,
    resolution: video.metadata?.resolution,
    aspectRatio: video.metadata?.aspect_ratio,
    generateAudio: video.metadata?.generate_audio,
    exploreMode: video.metadata?.explore_mode,
    progress: video.progress,
    videoUrl: video.video_url,
    thumbnailUrl: video.thumbnail_url,
    errorSummary: video.error?.message,
    errorCode: video.error?.code,
    errorCategory: video.error?.category,
    errorMessage: video.error?.runway_message,
    errorReason: video.error?.reason,
    errorDetail: video.error?.detail,
    error: video.error,
    createdAt: video.metadata?.created_at,
    updatedAt: video.metadata?.updated_at,
    submittedAt: video.metadata?.submitted_at,
    completedAt: video.metadata?.completed_at,
    assets: video.metadata?.assets || []
  };
}

function fromV1Status(status) {
  return {
    queued: 'pending',
    in_progress: 'generating',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled'
  }[status] || status || 'unknown';
}

async function refreshConfig() {
  const cfg = await fetchJson('/api/config');
  fillConfig(cfg);
}

function fillConfig(cfg) {
  el.configForm.username.value = cfg.username || '';
  el.configForm.apiKey.value = cfg.apiKey || '';
  el.configForm.password.value = '';
}

async function refreshRuntimeConfig() {
  const cfg = await fetchJson('/api/runtime-config');
  state.runtimeConfig = cfg;
  fillRuntimeConfig(cfg);
}

function fillRuntimeConfig(cfg) {
  el.runtimeForm.requestTimeoutMs.value = cfg.requestTimeoutMs || 120000;
  el.runtimeForm.uploadTimeoutMinMs.value = cfg.uploadTimeoutMinMs || 30000;
  el.runtimeForm.uploadTimeoutMaxMs.value = cfg.uploadTimeoutMaxMs || 120000;
  el.runtimeForm.taskTimeoutMs.value = cfg.taskTimeoutMs || 1500000;
  el.runtimeForm.maxRetries.value = cfg.maxRetries ?? 3;
  el.runtimeForm.defaultGenerationLimit.value = cfg.defaultGenerationLimit || 80;
  el.runtimeForm.queueLeaseTimeoutMs.value = cfg.queueLeaseTimeoutMs || 120000;
  el.runtimeForm.staleTaskTimeoutMs.value = cfg.staleTaskTimeoutMs || 1800000;
  el.runtimeForm.logRetentionDays.value = cfg.logRetentionDays ?? 14;
  el.runtimeForm.uploadRetentionDays.value = cfg.uploadRetentionDays ?? 7;
  el.runtimeForm.retryBackoffMs.value = (cfg.retryBackoffMs || [1000, 3000, 7000]).join(',');
  el.runtimeForm.proxyStrategyDefault.value = cfg.proxyStrategyDefault || 'fixed';
  el.runtimeForm.forceProxy.checked = Boolean(cfg.forceProxy);
  el.runtimeForm.logRequestBody.checked = Boolean(cfg.logRequestBody);
  el.runtimeForm.logResponseBody.checked = Boolean(cfg.logResponseBody);
  el.runtimeForm.maskSecrets.checked = Boolean(cfg.maskSecrets);
}

async function refreshSystemVersion() {
  const version = await fetchJson('/api/system/version');
  el.versionState.textContent = `当前分支 ${version.branch || '-'}，版本 ${version.commit || '-'}`;
}

async function updateProject() {
  if (!confirm('确认从远端拉取最新代码？更新完成后通常需要重启服务才会完全生效。')) return;
  el.updateProject.disabled = true;
  el.updateOutput.textContent = '正在执行 git pull --ff-only ...';
  try {
    const result = await fetchJson('/api/system/update', { method: 'POST' });
    const output = [
      `更新状态：${result.updated ? '已更新' : '无需更新'}`,
      `更新前：${result.before?.branch || '-'} ${result.before?.commit || '-'}`,
      `更新后：${result.after?.branch || '-'} ${result.after?.commit || '-'}`,
      '',
      result.stdout || '',
      result.stderr || ''
    ].filter(Boolean).join('\n');
    el.updateOutput.textContent = output;
    await refreshSystemVersion();
  } catch (err) {
    el.updateOutput.textContent = `更新失败：${err.message}`;
  } finally {
    el.updateProject.disabled = false;
  }
}

async function refreshLogs() {
  const { logs } = await fetchJson('/api/logs');
  if (!logs?.length) {
    el.logs.innerHTML = '<div class="empty">暂无请求日志。</div>';
    return;
  }
  el.logs.innerHTML = `
    <div class="table-head logs-head"><span>时间</span><span>账号/代理</span><span>操作</span><span>状态</span><span>耗时</span><span>消息</span><span>操作</span></div>
    ${logs.map((log) => `
      <div class="table-row logs-row">
        <span>${formatDate(log.createdAt)}</span>
        <span>${escapeHtml(log.accountName || log.accountId || log.proxyName || log.proxyId || '-')}</span>
        <span>${escapeHtml(log.operation)}</span>
        <span class="badge ${log.status === 'success' || log.status === 'saved' || log.status === 'opened' ? 'completed' : 'failed'}">${escapeHtml(log.status)}${log.statusCode ? ` ${log.statusCode}` : ''}</span>
        <span>${log.durationMs == null ? '-' : `${log.durationMs}ms`}</span>
        <span>${escapeHtml(log.message || '-')}</span>
        <button type="button" data-log-detail="${escapeAttr(log.id)}">详情</button>
      </div>
    `).join('')}
  `;
  for (const button of $$('[data-log-detail]')) {
    button.addEventListener('click', async () => {
      const { log } = await fetchJson(`/api/logs/${button.dataset.logDetail}`);
      el.logDetail.textContent = JSON.stringify(log, null, 2);
      el.logDialog.showModal();
    });
  }
}

async function clearLogs() {
  if (!confirm('确认清空请求日志？')) return;
  await fetchJson('/api/logs', { method: 'DELETE' });
  await refreshLogs();
}

async function importJsonFile({ input, endpoint, label, refresh }) {
  const file = input.files[0];
  if (!file) return;
  try {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new Error('JSON 文件格式不正确，请检查文件内容。');
    }
    const result = await fetchJson(endpoint, jsonOptions('POST', data));
    await refresh();
    const imported = result.imported ?? result.accounts?.length ?? result.proxies?.length ?? 0;
    const skipped = result.skipped ?? 0;
    const errors = (result.errors || []).map((item) => `第 ${Number(item.index) + 1} 条：${item.message}`).join('\n');
    alert(`${label}导入完成：成功 ${imported} 条${skipped ? `，失败 ${skipped} 条` : ''}${errors ? `\n\n失败详情：\n${errors}` : ''}`);
  } catch (err) {
    alert(`${label}导入失败：${err.message}`);
  } finally {
    input.value = '';
  }
}

function jsonOptions(method, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(translateError(body?.message || body?.error, response.status));
  return body;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '-';
}

function formatStatus(status) {
  return {
    pending: '待提交',
    submitting: '提交中',
    queuing: '排队中',
    generating: '生成中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    unknown: '未知'
  }[status] || status || '-';
}

function maskProxyUrl(url) {
  return String(url || '').replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
}

function translateError(message, status) {
  if (status === 401 || message === 'unauthorized') return '未登录或权限已过期。';
  if (message === 'account not found') return '账号不存在。';
  if (message === 'task not found') return '任务不存在。';
  if (message === 'only failed tasks can be retried') return '只有失败任务可以重试。';
  if (message === 'proxy not found') return '代理不存在。';
  if (message === 'proxy url is required') return '请填写代理地址。';
  if (message === 'invalid proxy format' || message === 'invalid proxy url') return '代理格式不正确。';
  if (message === 'unsupported proxy protocol') return '不支持的代理协议。';
  if (message === 'accounts array or account object is required') return '导入文件里没有找到账号列表或账号对象。';
  if (message === 'proxies array or proxy object is required') return '导入文件里没有找到代理列表或代理对象。';
  if (message === 'prompt is required') return '请填写提示词。';
  return message || `请求失败：${status}`;
}
