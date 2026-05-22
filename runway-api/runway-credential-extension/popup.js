const $ = (selector) => document.querySelector(selector);

const el = {
  badge: $('#readyBadge'),
  jwt: $('#jwtState'),
  cookie: $('#cookieState'),
  team: $('#teamState'),
  asset: $('#assetState'),
  serverUrl: $('#serverUrl'),
  apiKey: $('#apiKey'),
  output: $('#output'),
  refresh: $('#refresh'),
  copy: $('#copy'),
  clear: $('#clear'),
  import: $('#import')
};

let currentAccount = null;

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await refreshState();
});

el.refresh.addEventListener('click', refreshState);
el.copy.addEventListener('click', copyJson);
el.clear.addEventListener('click', clearState);
el.import.addEventListener('click', importAccount);

async function loadSettings() {
  const response = await sendMessage({ type: 'get-settings' });
  el.serverUrl.value = response.settings?.serverUrl || 'http://127.0.0.1:8790';
  el.apiKey.value = response.settings?.apiKey || '';
}

async function refreshState() {
  setBusy(el.refresh, true);
  try {
    const response = await sendMessage({ type: 'get-state' });
    currentAccount = response.state || {};
    renderAccount(currentAccount);
  } catch (err) {
    showError(err);
  } finally {
    setBusy(el.refresh, false);
  }
}

async function copyJson() {
  if (!currentAccount) await refreshState();
  const json = JSON.stringify({ accounts: [currentAccount] }, null, 2);
  await navigator.clipboard.writeText(json);
  el.output.textContent = '已复制账号 JSON。\n\n' + maskJson(json);
}

async function clearState() {
  await sendMessage({ type: 'clear-state' });
  currentAccount = {};
  renderAccount(currentAccount);
}

async function importAccount() {
  setBusy(el.import, true);
  try {
    await sendMessage({
      type: 'save-settings',
      serverUrl: el.serverUrl.value,
      apiKey: el.apiKey.value
    });
    const response = await sendMessage({
      type: 'import',
      serverUrl: el.serverUrl.value,
      apiKey: el.apiKey.value
    });
    el.output.textContent = `导入完成：成功 ${response.result.imported || 0} 条，失败 ${response.result.skipped || 0} 条\n\n${JSON.stringify(response.result, null, 2)}`;
  } catch (err) {
    showError(err);
  } finally {
    setBusy(el.import, false);
    await refreshState();
  }
}

function renderAccount(account = {}) {
  el.jwt.textContent = account.jwt ? '已抓取' : '缺失';
  el.cookie.textContent = account.cookieHeader ? '已抓取' : '缺失';
  el.team.textContent = account.teamId || '缺失';
  el.asset.textContent = account.assetGroupId || '缺失';
  const ready = Boolean((account.jwt || account.authorization) && account.cookieHeader && account.teamId && account.assetGroupId);
  el.badge.textContent = ready ? '可导入' : '未就绪';
  el.badge.classList.toggle('ready', ready);
  el.output.textContent = maskJson(JSON.stringify({ accounts: [account] }, null, 2));
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || '操作失败'));
        return;
      }
      resolve(response);
    });
  });
}

function setBusy(button, busy) {
  button.disabled = busy;
}

function showError(err) {
  el.output.textContent = `错误：${err.message || err}`;
}

function maskJson(json) {
  return String(json)
    .replace(/("jwt":\s*")[^"]+/g, '$1***')
    .replace(/("authorization":\s*")[^"]+/g, '$1Bearer ***')
    .replace(/("cookieHeader":\s*")[^"]+/g, '$1***');
}
