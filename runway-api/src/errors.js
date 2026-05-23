export function normalizeTaskError(error, rawStatus = null) {
  const detail = error || null;
  const raw = detail?.raw && typeof detail.raw === 'object' ? detail.raw : null;
  const body = detail?.body && typeof detail.body === 'object' ? detail.body : null;
  const source = raw || body || detail || {};
  const code = firstString(
    detail?.code,
    findByKey(source, ['code', 'errorCode', 'failureCode', 'reason']),
    source.code,
    source.reason,
    source.errorCode,
    source.failureCode,
    rawStatus
  );
  const category = firstString(
    detail?.category,
    findByKey(source, ['category', 'errorCategory', 'moderation_category', 'moderationCategory']),
    source.moderation_category,
    source.category,
    source.errorCategory
  );
  const message = firstString(
    detail?.message,
    findByKey(source, ['message', 'errorMessage', 'failureReason', 'errorReason', 'reason', 'detail']),
    source.errorMessage,
    source.message,
    source.failureReason,
    source.errorReason,
    source.reason
  );
  return {
    errorSummary: summarizeError({ code, category, message, detail }),
    errorCode: code,
    errorCategory: category,
    errorDetail: detail
  };
}

export function summarizeError({ code, category, message, detail }) {
  const haystack = [code, category, message, JSON.stringify(detail || {})].filter(Boolean).join(' ');
  if (/TASK_TIMEOUT|maximum runtime|最大运行时间/i.test(haystack)) {
    return '任务超过最大运行时间';
  }
  if (/SAFETY\.INPUT\.TEXT|Text did not pass content moderation/i.test(haystack)) {
    return '提示词未通过内容审核';
  }
  if (/SAFETY\.INPUT\.MULTIMODAL|Input media did not pass content moderation|content moderation/i.test(haystack)) {
    return '参考素材未通过内容审核';
  }
  if (/SEXUALLY_EXPLICIT/i.test(haystack)) {
    return '内容未通过安全审核';
  }
  if (/AUTH_FAILED|401|403|jwt|credential|unauthorized/i.test(haystack)) {
    return '账号凭证失效';
  }
  if (/S3 upload|upload failed|RequestTimeout|AbortError|timeout/i.test(haystack)) {
    return '上传或请求超时';
  }
  if (/\b5\d\d\b|RUNWAY_REQUEST_FAILED|Bad Gateway|Service Unavailable/i.test(haystack)) {
    return 'Runway 服务暂时不可用';
  }
  if (/NO_RUNWAY_CREDENTIALS|NO_COOKIE|COOKIE_REFRESH_FAILED/i.test(haystack)) {
    return '账号凭证未就绪';
  }
  return message || code || '任务失败';
}

function firstString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function findByKey(value, keys) {
  if (!value || typeof value !== 'object') return null;
  const wanted = new Set(keys);
  const queue = [value];
  const seen = new Set();
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (wanted.has(key) && child != null && typeof child !== 'object') {
        const text = String(child).trim();
        if (text) return text;
      }
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return null;
}
