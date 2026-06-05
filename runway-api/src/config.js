import path from 'node:path';

const bool = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  const dbPath = path.resolve(env.DB_PATH || path.join(dataDir, 'runway-api.sqlite'));
  const uploadDir = path.resolve(env.UPLOAD_DIR || path.join(dataDir, 'uploads'));
  const browserProfilesDir = path.resolve(env.BROWSER_PROFILES_DIR || path.join(dataDir, 'browser-profiles'));
  return {
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 8787),
    internalApiKey: env.INTERNAL_API_KEY || 'change-me',
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    videoProxyTokenTtlSeconds: int(env.VIDEO_PROXY_TOKEN_TTL_SECONDS, 3600),
    mediaAccelEnabled: bool(env.MEDIA_ACCEL_ENABLED, false),
    mediaAccelPrefix: env.MEDIA_ACCEL_PREFIX || '/__runway_media_proxy__/',
    autoRestartOnUpdate: bool(env.AUTO_RESTART_ON_UPDATE, true),
    restartCommand: env.RESTART_COMMAND || '',
    pm2ProcessName: env.PM2_PROCESS_NAME || env.RUNWAY_PM2_NAME || 'runway-api',
    adminUsername: env.ADMIN_USERNAME || 'admin',
    adminPassword: env.ADMIN_PASSWORD || 'admin',
    dataDir,
    dbPath,
    uploadDir,
    browserProfileDir: path.resolve(dataDir, 'browser-profile'),
    browserProfilesDir,
    browserHeadless: bool(env.RUNWAY_BROWSER_HEADLESS, false),
    maxConcurrent: int(env.RUNWAY_MAX_CONCURRENT, 2),
    defaultAccountConcurrency: int(env.RUNWAY_ACCOUNT_CONCURRENCY, 2),
    requestTimeoutMs: int(env.RUNWAY_REQUEST_TIMEOUT_MS, 120000),
    uploadTimeoutMinMs: int(env.RUNWAY_UPLOAD_TIMEOUT_MIN_MS, 30000),
    uploadTimeoutMaxMs: int(env.RUNWAY_UPLOAD_TIMEOUT_MAX_MS, 120000),
    taskTimeoutMs: int(env.RUNWAY_TASK_TIMEOUT_MS, 1500000),
    maxRetries: int(env.RUNWAY_MAX_RETRIES, 3),
    pollIntervalMs: int(env.RUNWAY_POLL_INTERVAL_MS, 8000),
    pollIntervalSlowMs: int(env.RUNWAY_POLL_INTERVAL_SLOW_MS, 20000),
    submitIntervalMinMs: int(env.RUNWAY_SUBMIT_INTERVAL_MIN_MS, 3000),
    submitIntervalMaxMs: int(env.RUNWAY_SUBMIT_INTERVAL_MAX_MS, 8000),
    upstreamAutoRetryAttempts: int(env.RUNWAY_UPSTREAM_AUTO_RETRY_ATTEMPTS, 3),
    queueLeaseTimeoutMs: int(env.RUNWAY_QUEUE_LEASE_TIMEOUT_MS, 120000),
    staleTaskTimeoutMs: int(env.RUNWAY_STALE_TASK_TIMEOUT_MS, 1800000),
    logRetentionDays: int(env.LOG_RETENTION_DAYS, 14),
    uploadRetentionDays: int(env.UPLOAD_RETENTION_DAYS, 7)
  };
}
