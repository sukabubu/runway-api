export function extractAuth(headersLike) {
  if (!headersLike) return null;
  if (typeof headersLike.get === 'function') {
    return headersLike.get('authorization') || headersLike.get('Authorization');
  }
  if (Array.isArray(headersLike)) {
    const found = headersLike.find(([key]) => String(key).toLowerCase() === 'authorization');
    return found ? found[1] : null;
  }
  if (typeof headersLike === 'object') {
    return headersLike.authorization || headersLike.Authorization || null;
  }
  return null;
}

export function extractCookie(headersLike) {
  if (!headersLike) return null;
  if (typeof headersLike.get === 'function') {
    return headersLike.get('cookie') || headersLike.get('Cookie');
  }
  if (Array.isArray(headersLike)) {
    const found = headersLike.find(([key]) => String(key).toLowerCase() === 'cookie');
    return found ? found[1] : null;
  }
  if (typeof headersLike === 'object') {
    return headersLike.cookie || headersLike.Cookie || null;
  }
  return null;
}

export function extractCredentialsFromRequest({ url, method, headers, postData }) {
  const patch = {};
  const auth = extractAuth(headers);
  if (auth && String(auth).startsWith('Bearer ')) {
    patch.jwt = String(auth).slice(7).trim();
  }
  const cookie = extractCookie(headers);
  if (cookie) patch.cookieHeader = String(cookie);

  try {
    const parsed = new URL(url);
    const teamId = Number(parsed.searchParams.get('asTeamId'));
    if (Number.isFinite(teamId) && teamId > 0) patch.teamId = teamId;
  } catch {}

  const header = (name) => {
    const lower = name.toLowerCase();
    if (!headers || typeof headers !== 'object') return null;
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lower) return value;
    }
    return null;
  };

  const clientId = header('x-runway-client-id');
  if (clientId) patch.clientId = String(clientId);
  const version = header('x-runway-source-application-version');
  if (version) patch.sourceApplicationVersion = String(version);

  if (postData && ['POST', 'PUT', 'PATCH'].includes(String(method || '').toUpperCase())) {
    const bodyPatch = extractCredentialsFromJson(postData);
    Object.assign(patch, bodyPatch);
  }

  return patch;
}

export function extractCredentialsFromJson(text) {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return {};
  try {
    const body = JSON.parse(text);
    const patch = {};
    const assetGroupId = findFirstValue(body, [
      'assetGroupId',
      'asset_group_id',
      'defaultAssetGroupId'
    ]);
    if (assetGroupId) patch.assetGroupId = String(assetGroupId);
    const teamId = Number(findFirstValue(body, [
      'asTeamId',
      'teamId',
      'team_id',
      'workspaceId'
    ]));
    if (Number.isFinite(teamId) && teamId > 0) patch.teamId = teamId;
    return patch;
  } catch {
    return {};
  }
}

export function extractCredentialsFromResponse({ url, text }) {
  const target = String(url || '');
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return {};
  try {
    const body = JSON.parse(text);
    const patch = {};
    const assetGroupId = body?.assetGroup?.id ||
      (target.includes('/v1/asset_groups') ? body?.id : null) ||
      findFirstValue(body, ['assetGroupId', 'asset_group_id', 'defaultAssetGroupId']);
    if (assetGroupId) patch.assetGroupId = String(assetGroupId);
    const teamId = Number(findFirstValue(body, ['asTeamId', 'teamId', 'team_id', 'workspaceId']));
    if (Number.isFinite(teamId) && teamId > 0) patch.teamId = teamId;
    return patch;
  } catch {
    return {};
  }
}

function findFirstValue(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return null;
  for (const key of keys) {
    if (value[key] != null && value[key] !== '') return value[key];
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object') continue;
    const found = findFirstValue(child, keys, depth + 1);
    if (found != null && found !== '') return found;
  }
  return null;
}

export function isUsableCredentialPatch(patch) {
  return Boolean(
    patch &&
    (patch.jwt || patch.cookieHeader || patch.teamId || patch.assetGroupId || patch.clientId || patch.sourceApplicationVersion)
  );
}
