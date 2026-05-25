import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { normalizeTaskError } from './errors.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set(['submitting', 'queuing', 'generating']);
const DEFAULT_RUNTIME_CONFIG = {
  request_timeout_ms: 120000,
  upload_timeout_min_ms: 30000,
  upload_timeout_max_ms: 120000,
  task_timeout_ms: 1500000,
  max_retries: 3,
  default_generation_limit: 80,
  retry_backoff_ms: '[1000,3000,7000]',
  proxy_strategy_default: 'fixed',
  force_proxy: 0,
  log_request_body: 1,
  log_response_body: 1,
  mask_secrets: 1,
  queue_lease_timeout_ms: 120000,
  stale_task_timeout_ms: 1800000,
  log_retention_days: 14,
  upload_retention_days: 7
};

export class RunwayDatabase {
  constructor(dbPath, options = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.options = options;
    this.defaultRuntimeConfig = {
      ...DEFAULT_RUNTIME_CONFIG,
      request_timeout_ms: options.requestTimeoutMs ?? DEFAULT_RUNTIME_CONFIG.request_timeout_ms,
      upload_timeout_min_ms: options.uploadTimeoutMinMs ?? DEFAULT_RUNTIME_CONFIG.upload_timeout_min_ms,
      upload_timeout_max_ms: options.uploadTimeoutMaxMs ?? DEFAULT_RUNTIME_CONFIG.upload_timeout_max_ms,
      task_timeout_ms: options.taskTimeoutMs ?? DEFAULT_RUNTIME_CONFIG.task_timeout_ms,
      max_retries: options.maxRetries ?? DEFAULT_RUNTIME_CONFIG.max_retries,
      queue_lease_timeout_ms: options.queueLeaseTimeoutMs ?? DEFAULT_RUNTIME_CONFIG.queue_lease_timeout_ms,
      stale_task_timeout_ms: options.staleTaskTimeoutMs ?? DEFAULT_RUNTIME_CONFIG.stale_task_timeout_ms,
      log_retention_days: options.logRetentionDays ?? DEFAULT_RUNTIME_CONFIG.log_retention_days,
      upload_retention_days: options.uploadRetentionDays ?? DEFAULT_RUNTIME_CONFIG.upload_retention_days
    };
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma(`busy_timeout = ${Number(options.busyTimeoutMs) || 5000}`);
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        jwt TEXT,
        team_id INTEGER,
        asset_group_id TEXT,
        client_id TEXT,
        source_application_version TEXT,
        captured_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        remark TEXT,
        jwt TEXT,
        cookie_header TEXT,
        team_id INTEGER,
        asset_group_id TEXT,
        client_id TEXT,
        source_application_version TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        max_concurrent INTEGER NOT NULL DEFAULT 2,
        proxy_id TEXT,
        proxy_strategy TEXT NOT NULL DEFAULT 'fixed',
        generation_limit INTEGER NOT NULL DEFAULT 80,
        generation_used INTEGER NOT NULL DEFAULT 0,
        generation_reset_at TEXT,
        request_timeout_ms INTEGER,
        upload_timeout_ms INTEGER,
        task_timeout_ms INTEGER,
        max_retries INTEGER,
        runway_credits_json TEXT,
        runway_credits_checked_at TEXT,
        inflight INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        consecutive_error_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_auth_failed_at TEXT,
        last_used_at TEXT,
        captured_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proxies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        protocol TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        use_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        request_timeout_ms INTEGER NOT NULL DEFAULT 120000,
        upload_timeout_min_ms INTEGER NOT NULL DEFAULT 30000,
        upload_timeout_max_ms INTEGER NOT NULL DEFAULT 120000,
        task_timeout_ms INTEGER NOT NULL DEFAULT 1500000,
        max_retries INTEGER NOT NULL DEFAULT 3,
        default_generation_limit INTEGER NOT NULL DEFAULT 80,
        retry_backoff_ms TEXT NOT NULL DEFAULT '[1000,3000,7000]',
        proxy_strategy_default TEXT NOT NULL DEFAULT 'fixed',
        force_proxy INTEGER NOT NULL DEFAULT 0,
        log_request_body INTEGER NOT NULL DEFAULT 1,
        log_response_body INTEGER NOT NULL DEFAULT 1,
        mask_secrets INTEGER NOT NULL DEFAULT 1,
        queue_lease_timeout_ms INTEGER NOT NULL DEFAULT 120000,
        stale_task_timeout_ms INTEGER NOT NULL DEFAULT 1800000,
        log_retention_days INTEGER NOT NULL DEFAULT 14,
        upload_retention_days INTEGER NOT NULL DEFAULT 7,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        api_key TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        proxy_id TEXT,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        status_code INTEGER,
        duration_ms INTEGER,
        message TEXT,
        request_body TEXT,
        response_body TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        parent_task_id TEXT,
        account_id TEXT,
        runway_task_id TEXT,
        status TEXT NOT NULL,
        raw_status TEXT,
        prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        duration INTEGER NOT NULL,
        resolution TEXT NOT NULL,
        aspect_ratio TEXT NOT NULL,
        generate_audio INTEGER NOT NULL,
        explore_mode INTEGER NOT NULL,
        progress INTEGER,
        video_url TEXT,
        thumbnail_url TEXT,
        error TEXT,
        raw_response TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        submitted_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        account_id TEXT,
        type TEXT NOT NULL,
        message TEXT,
        data TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        account_id TEXT,
        local_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT,
        media_type TEXT,
        size INTEGER NOT NULL,
        runway_asset_id TEXT,
        runway_url TEXT,
        preview_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
    `);

    this.addColumnIfMissing('tasks', 'account_id', 'TEXT');
    this.addColumnIfMissing('tasks', 'locked_by', 'TEXT');
    this.addColumnIfMissing('tasks', 'locked_at', 'TEXT');
    this.addColumnIfMissing('tasks', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('tasks', 'last_heartbeat_at', 'TEXT');
    this.addColumnIfMissing('assets', 'account_id', 'TEXT');
    this.addColumnIfMissing('assets', 'media_type', 'TEXT');
    this.addColumnIfMissing('accounts', 'cookie_header', 'TEXT');
    this.addColumnIfMissing('accounts', 'proxy_id', 'TEXT');
    this.addColumnIfMissing('accounts', 'proxy_strategy', "TEXT NOT NULL DEFAULT 'fixed'");
    this.addColumnIfMissing('accounts', 'generation_limit', 'INTEGER NOT NULL DEFAULT 80');
    this.addColumnIfMissing('accounts', 'generation_used', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('accounts', 'generation_reset_at', 'TEXT');
    this.addColumnIfMissing('accounts', 'request_timeout_ms', 'INTEGER');
    this.addColumnIfMissing('accounts', 'upload_timeout_ms', 'INTEGER');
    this.addColumnIfMissing('accounts', 'task_timeout_ms', 'INTEGER');
    this.addColumnIfMissing('accounts', 'max_retries', 'INTEGER');
    this.addColumnIfMissing('accounts', 'runway_credits_json', 'TEXT');
    this.addColumnIfMissing('accounts', 'runway_credits_checked_at', 'TEXT');
    this.addColumnIfMissing('accounts', 'last_auth_failed_at', 'TEXT');
    this.addColumnIfMissing('request_logs', 'proxy_id', 'TEXT');
    this.addColumnIfMissing('request_logs', 'status_code', 'INTEGER');
    this.addColumnIfMissing('request_logs', 'duration_ms', 'INTEGER');
    this.addColumnIfMissing('request_logs', 'request_body', 'TEXT');
    this.addColumnIfMissing('request_logs', 'response_body', 'TEXT');
    this.addColumnIfMissing('runtime_config', 'queue_lease_timeout_ms', 'INTEGER NOT NULL DEFAULT 120000');
    this.addColumnIfMissing('runtime_config', 'stale_task_timeout_ms', 'INTEGER NOT NULL DEFAULT 1800000');
    this.addColumnIfMissing('runtime_config', 'log_retention_days', 'INTEGER NOT NULL DEFAULT 14');
    this.addColumnIfMissing('runtime_config', 'upload_retention_days', 'INTEGER NOT NULL DEFAULT 7');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(status, locked_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_account_status ON tasks(account_id, status);
      CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);
    `);
    this.ensureAdminConfig();
    this.ensureRuntimeConfig();
    this.migrateCredentialsToAccount();
    this.migrateDefaultAccount();
    this.rebuildAccountInflight();
  }

  addColumnIfMissing(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  ensureAdminConfig() {
    const row = this.db.prepare('SELECT id FROM admin_config WHERE id = 1').get();
    if (row) return;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO admin_config (id, username, password, api_key, updated_at)
      VALUES (1, @username, @password, @apiKey, @updatedAt)
    `).run({
      username: this.options.adminUsername || 'admin',
      password: this.options.adminPassword || 'admin',
      apiKey: this.options.internalApiKey || 'change-me',
      updatedAt: now
    });
  }

  ensureRuntimeConfig() {
    const row = this.db.prepare('SELECT id FROM runtime_config WHERE id = 1').get();
    if (row) return;
    this.db.prepare(`
      INSERT INTO runtime_config (
        id, request_timeout_ms, upload_timeout_min_ms, upload_timeout_max_ms,
        task_timeout_ms, max_retries, default_generation_limit, retry_backoff_ms,
        proxy_strategy_default, force_proxy, log_request_body, log_response_body,
        mask_secrets, queue_lease_timeout_ms, stale_task_timeout_ms,
        log_retention_days, upload_retention_days, updated_at
      ) VALUES (
        1, @request_timeout_ms, @upload_timeout_min_ms, @upload_timeout_max_ms,
        @task_timeout_ms, @max_retries, @default_generation_limit, @retry_backoff_ms,
        @proxy_strategy_default, @force_proxy, @log_request_body, @log_response_body,
        @mask_secrets, @queue_lease_timeout_ms, @stale_task_timeout_ms,
        @log_retention_days, @upload_retention_days, @updatedAt
      )
    `).run({ ...this.defaultRuntimeConfig, updatedAt: new Date().toISOString() });
  }

  getRuntimeConfig() {
    const row = this.db.prepare('SELECT * FROM runtime_config WHERE id = 1').get();
    return hydrateRuntimeConfig(row || { ...DEFAULT_RUNTIME_CONFIG, updated_at: null });
  }

  updateRuntimeConfig(patch = {}) {
    const current = this.getRuntimeConfig();
    const next = {
      requestTimeoutMs: normalizeMs(patch.requestTimeoutMs ?? patch.request_timeout_ms, current.requestTimeoutMs, 1000),
      uploadTimeoutMinMs: normalizeMs(patch.uploadTimeoutMinMs ?? patch.upload_timeout_min_ms, current.uploadTimeoutMinMs, 1000),
      uploadTimeoutMaxMs: normalizeMs(patch.uploadTimeoutMaxMs ?? patch.upload_timeout_max_ms, current.uploadTimeoutMaxMs, 1000),
      taskTimeoutMs: normalizeMs(patch.taskTimeoutMs ?? patch.task_timeout_ms, current.taskTimeoutMs, 1000),
      maxRetries: normalizeNonNegativeInt(patch.maxRetries ?? patch.max_retries, current.maxRetries),
      defaultGenerationLimit: normalizeGenerationLimit(patch.defaultGenerationLimit ?? patch.default_generation_limit ?? current.defaultGenerationLimit),
      retryBackoffMs: normalizeRetryBackoff(patch.retryBackoffMs ?? patch.retry_backoff_ms ?? current.retryBackoffMs),
      proxyStrategyDefault: normalizeProxyStrategy(patch.proxyStrategyDefault ?? patch.proxy_strategy_default ?? current.proxyStrategyDefault),
      forceProxy: toDbBool(patch.forceProxy ?? patch.force_proxy ?? current.forceProxy),
      logRequestBody: toDbBool(patch.logRequestBody ?? patch.log_request_body ?? current.logRequestBody),
      logResponseBody: toDbBool(patch.logResponseBody ?? patch.log_response_body ?? current.logResponseBody),
      maskSecrets: toDbBool(patch.maskSecrets ?? patch.mask_secrets ?? current.maskSecrets),
      queueLeaseTimeoutMs: normalizeMs(patch.queueLeaseTimeoutMs ?? patch.queue_lease_timeout_ms, current.queueLeaseTimeoutMs, 1000),
      staleTaskTimeoutMs: normalizeMs(patch.staleTaskTimeoutMs ?? patch.stale_task_timeout_ms, current.staleTaskTimeoutMs, 1000),
      logRetentionDays: normalizeNonNegativeInt(patch.logRetentionDays ?? patch.log_retention_days, current.logRetentionDays),
      uploadRetentionDays: normalizeNonNegativeInt(patch.uploadRetentionDays ?? patch.upload_retention_days, current.uploadRetentionDays),
      updatedAt: new Date().toISOString()
    };
    if (next.uploadTimeoutMaxMs < next.uploadTimeoutMinMs) next.uploadTimeoutMaxMs = next.uploadTimeoutMinMs;
    this.db.prepare(`
      UPDATE runtime_config SET
        request_timeout_ms = @requestTimeoutMs,
        upload_timeout_min_ms = @uploadTimeoutMinMs,
        upload_timeout_max_ms = @uploadTimeoutMaxMs,
        task_timeout_ms = @taskTimeoutMs,
        max_retries = @maxRetries,
        default_generation_limit = @defaultGenerationLimit,
        retry_backoff_ms = @retryBackoffMs,
        proxy_strategy_default = @proxyStrategyDefault,
        force_proxy = @forceProxy,
        log_request_body = @logRequestBody,
        log_response_body = @logResponseBody,
        mask_secrets = @maskSecrets,
        queue_lease_timeout_ms = @queueLeaseTimeoutMs,
        stale_task_timeout_ms = @staleTaskTimeoutMs,
        log_retention_days = @logRetentionDays,
        upload_retention_days = @uploadRetentionDays,
        updated_at = @updatedAt
      WHERE id = 1
    `).run(next);
    return this.getRuntimeConfig();
  }

  migrateCredentialsToAccount() {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count;
    if (count > 0) return;
    const creds = this.db.prepare('SELECT * FROM credentials WHERE id = 1').get();
    if (!creds || !(creds.jwt || creds.team_id || creds.asset_group_id || creds.client_id)) return;
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO accounts (
        id, name, remark, jwt, cookie_header, team_id, asset_group_id, client_id, source_application_version,
        is_active, max_concurrent, inflight, error_count, consecutive_error_count,
        captured_at, created_at, updated_at
      ) VALUES (
        @id, @name, @remark, @jwt, @cookieHeader, @teamId, @assetGroupId, @clientId, @sourceApplicationVersion,
        1, @maxConcurrent, 0, 0, 0, @capturedAt, @createdAt, @updatedAt
      )
    `).run({
      id,
      name: '迁移账号',
      remark: '由旧 credentials 自动迁移',
      jwt: creds.jwt || null,
      cookieHeader: null,
      teamId: creds.team_id || null,
      assetGroupId: creds.asset_group_id || null,
      clientId: creds.client_id || null,
      sourceApplicationVersion: creds.source_application_version || null,
      maxConcurrent: this.options.defaultAccountConcurrency || 2,
      capturedAt: creds.captured_at || now,
      createdAt: now,
      updatedAt: now
    });
    this.db.prepare('UPDATE tasks SET account_id = ? WHERE account_id IS NULL').run(id);
    this.db.prepare('UPDATE assets SET account_id = ? WHERE account_id IS NULL').run(id);
  }

  migrateDefaultAccount() {
    const account = this.db.prepare("SELECT * FROM accounts WHERE id = 'default'").get();
    if (!account) return;
    const newId = randomUUID();
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE accounts
        SET id = @newId,
            name = CASE WHEN name = '默认账号' THEN '迁移账号' ELSE name END,
            remark = COALESCE(remark, '由默认账号迁移'),
            updated_at = @now
        WHERE id = 'default'
      `).run({ newId, now });
      this.db.prepare("UPDATE tasks SET account_id = @newId WHERE account_id = 'default'").run({ newId });
      this.db.prepare("UPDATE assets SET account_id = @newId WHERE account_id = 'default'").run({ newId });
      this.db.prepare("UPDATE request_logs SET account_id = @newId WHERE account_id = 'default'").run({ newId });
    });
    tx();
    this.migrateDefaultBrowserProfile(newId);
  }

  migrateDefaultBrowserProfile(newId) {
    const baseDir = this.options.browserProfilesDir || path.join(path.dirname(this.options.dbPath || ''), 'browser-profiles');
    const oldPath = path.join(baseDir, 'default');
    const newPath = path.join(baseDir, String(newId));
    if (!fs.existsSync(oldPath) || fs.existsSync(newPath)) return;
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.renameSync(oldPath, newPath);
  }

  close() {
    this.db.close();
  }

  getAdminConfig() {
    return this.db.prepare('SELECT * FROM admin_config WHERE id = 1').get();
  }

  updateAdminConfig(patch = {}) {
    const current = this.getAdminConfig();
    const next = {
      username: patch.username || current.username,
      password: patch.password || current.password,
      apiKey: patch.apiKey || patch.api_key,
      updatedAt: new Date().toISOString()
    };
    this.db.prepare(`
      UPDATE admin_config SET username = @username, password = @password, api_key = @apiKey, updated_at = @updatedAt
      WHERE id = 1
    `).run(next);
    return this.getAdminConfig();
  }

  createSession(ttlMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const session = {
      id: randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString()
    };
    this.db.prepare(`
      INSERT INTO admin_sessions (id, created_at, expires_at)
      VALUES (@id, @createdAt, @expiresAt)
    `).run(session);
    return session;
  }

  getSession(id) {
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM admin_sessions WHERE id = ?').get(id);
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.deleteSession(id);
      return null;
    }
    return row;
  }

  deleteSession(id) {
    this.db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(id);
  }

  createAccount(input = {}) {
    const now = new Date().toISOString();
    const id = input.id || randomUUID();
    const runtime = this.getRuntimeConfig();
    this.db.prepare(`
      INSERT INTO accounts (
        id, name, remark, jwt, cookie_header, team_id, asset_group_id, client_id, source_application_version,
        is_active, max_concurrent, proxy_id, proxy_strategy, generation_limit, generation_used,
        generation_reset_at, request_timeout_ms, upload_timeout_ms, task_timeout_ms, max_retries,
        runway_credits_json, runway_credits_checked_at,
        inflight, error_count, consecutive_error_count, last_error, last_auth_failed_at, last_used_at,
        captured_at, created_at, updated_at
      ) VALUES (
        @id, @name, @remark, @jwt, @cookieHeader, @teamId, @assetGroupId, @clientId, @sourceApplicationVersion,
        @isActive, @maxConcurrent, @proxyId, @proxyStrategy, @generationLimit, @generationUsed,
        @generationResetAt, @requestTimeoutMs, @uploadTimeoutMs, @taskTimeoutMs, @maxRetries,
        @runwayCreditsJson, @runwayCreditsCheckedAt,
        @inflight, @errorCount, @consecutiveErrorCount, @lastError, @lastAuthFailedAt, @lastUsedAt,
        @capturedAt, @createdAt, @updatedAt
      )
    `).run({
      id,
      name: input.name || 'Runway 账号',
      remark: input.remark || null,
      jwt: input.jwt || null,
      cookieHeader: input.cookieHeader ?? input.cookie_header ?? input.cookie ?? null,
      teamId: input.teamId ?? input.team_id ?? null,
      assetGroupId: input.assetGroupId ?? input.asset_group_id ?? null,
      clientId: input.clientId ?? input.client_id ?? null,
      sourceApplicationVersion:
        input.sourceApplicationVersion ?? input.source_application_version ?? null,
      isActive: normalizeBooleanFlag(input.isActive ?? input.is_active, 1),
      maxConcurrent: normalizeConcurrency(input.maxConcurrent ?? input.max_concurrent ?? this.options.defaultAccountConcurrency ?? 2),
      proxyId: input.proxyId ?? input.proxy_id ?? null,
      proxyStrategy: normalizeProxyStrategy(input.proxyStrategy ?? input.proxy_strategy ?? runtime.proxyStrategyDefault),
      generationLimit: normalizeGenerationLimit(input.generationLimit ?? input.generation_limit ?? runtime.defaultGenerationLimit),
      generationUsed: normalizeNonNegativeInt(input.generationUsed ?? input.generation_used, 0),
      generationResetAt: input.generationResetAt ?? input.generation_reset_at ?? null,
      requestTimeoutMs: normalizeOptionalMs(input.requestTimeoutMs ?? input.request_timeout_ms),
      uploadTimeoutMs: normalizeOptionalMs(input.uploadTimeoutMs ?? input.upload_timeout_ms),
      taskTimeoutMs: normalizeOptionalMs(input.taskTimeoutMs ?? input.task_timeout_ms),
      maxRetries: normalizeOptionalNonNegativeInt(input.maxRetries ?? input.max_retries),
      runwayCreditsJson: input.runwayCreditsJson ?? input.runway_credits_json ?? null,
      runwayCreditsCheckedAt: input.runwayCreditsCheckedAt ?? input.runway_credits_checked_at ?? null,
      inflight: Math.max(Number(input.inflight) || 0, 0),
      errorCount: Math.max(Number(input.errorCount ?? input.error_count) || 0, 0),
      consecutiveErrorCount: Math.max(Number(input.consecutiveErrorCount ?? input.consecutive_error_count) || 0, 0),
      lastError: input.lastError ?? input.last_error ?? null,
      lastAuthFailedAt: input.lastAuthFailedAt ?? input.last_auth_failed_at ?? null,
      lastUsedAt: input.lastUsedAt ?? input.last_used_at ?? null,
      capturedAt: input.capturedAt ?? input.captured_at ?? (input.jwt || input.cookieHeader || input.cookie_header || input.cookie ? now : null),
      createdAt: input.createdAt ?? input.created_at ?? now,
      updatedAt: now
    });
    return this.getAccount(id, { includeSecret: true });
  }

  listAccounts({ includeSecret = false } = {}) {
    this.resetExpiredGenerationUsage();
    const rows = this.db.prepare(`
      SELECT accounts.*, proxies.name AS proxy_name, proxies.url AS proxy_url
      FROM accounts
      LEFT JOIN proxies ON proxies.id = accounts.proxy_id
      ORDER BY accounts.created_at ASC
    `).all();
    return rows.map((row) => hydrateAccount(row, { includeSecret }));
  }

  getAccount(id, { includeSecret = false } = {}) {
    this.resetExpiredGenerationUsage(id);
    const row = this.db.prepare(`
      SELECT accounts.*, proxies.name AS proxy_name, proxies.url AS proxy_url
      FROM accounts
      LEFT JOIN proxies ON proxies.id = accounts.proxy_id
      WHERE accounts.id = ?
    `).get(id);
    return row ? hydrateAccount(row, { includeSecret }) : null;
  }

  updateAccount(id, patch = {}) {
    const current = this.getAccount(id, { includeSecret: true });
    if (!current) return null;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE accounts SET
        name = @name,
        remark = @remark,
        jwt = @jwt,
        cookie_header = @cookieHeader,
        team_id = @teamId,
        asset_group_id = @assetGroupId,
        client_id = @clientId,
        source_application_version = @sourceApplicationVersion,
        is_active = @isActive,
        max_concurrent = @maxConcurrent,
        proxy_id = @proxyId,
        proxy_strategy = @proxyStrategy,
        generation_limit = @generationLimit,
        generation_used = @generationUsed,
        generation_reset_at = @generationResetAt,
        request_timeout_ms = @requestTimeoutMs,
        upload_timeout_ms = @uploadTimeoutMs,
        task_timeout_ms = @taskTimeoutMs,
        max_retries = @maxRetries,
        runway_credits_json = @runwayCreditsJson,
        runway_credits_checked_at = @runwayCreditsCheckedAt,
        inflight = @inflight,
        error_count = @errorCount,
        consecutive_error_count = @consecutiveErrorCount,
        last_error = @lastError,
        last_auth_failed_at = @lastAuthFailedAt,
        last_used_at = @lastUsedAt,
        captured_at = @capturedAt,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id,
      name: patch.name ?? current.name,
      remark: patch.remark ?? current.remark,
      jwt: patch.jwt ?? current.jwt ?? null,
      cookieHeader: patch.cookieHeader ?? patch.cookie_header ?? patch.cookie ?? current.cookieHeader ?? null,
      teamId: patch.teamId ?? patch.team_id ?? current.teamId ?? null,
      assetGroupId: patch.assetGroupId ?? patch.asset_group_id ?? current.assetGroupId ?? null,
      clientId: patch.clientId ?? patch.client_id ?? current.clientId ?? null,
      sourceApplicationVersion:
        patch.sourceApplicationVersion ??
        patch.source_application_version ??
        current.sourceApplicationVersion ??
        null,
      isActive: normalizeBooleanFlag(patch.isActive ?? patch.is_active, current.isActive ? 1 : 0),
      maxConcurrent: normalizeConcurrency(patch.maxConcurrent ?? patch.max_concurrent ?? current.maxConcurrent),
      proxyId: pickPatchValue(patch, ['proxyId', 'proxy_id'], current.proxyId ?? null),
      proxyStrategy: normalizeProxyStrategy(patch.proxyStrategy ?? patch.proxy_strategy ?? current.proxyStrategy),
      generationLimit: normalizeGenerationLimit(patch.generationLimit ?? patch.generation_limit ?? current.generationLimit),
      generationUsed: normalizeNonNegativeInt(patch.generationUsed ?? patch.generation_used, current.generationUsed),
      generationResetAt: patch.generationResetAt ?? patch.generation_reset_at ?? current.generationResetAt ?? null,
      requestTimeoutMs: normalizeOptionalMs(patch.requestTimeoutMs ?? patch.request_timeout_ms ?? current.requestTimeoutMs),
      uploadTimeoutMs: normalizeOptionalMs(patch.uploadTimeoutMs ?? patch.upload_timeout_ms ?? current.uploadTimeoutMs),
      taskTimeoutMs: normalizeOptionalMs(patch.taskTimeoutMs ?? patch.task_timeout_ms ?? current.taskTimeoutMs),
      maxRetries: normalizeOptionalNonNegativeInt(patch.maxRetries ?? patch.max_retries ?? current.maxRetries),
      runwayCreditsJson: pickPatchValue(patch, ['runwayCreditsJson', 'runway_credits_json'], current.runwayCreditsJson ?? null),
      runwayCreditsCheckedAt: pickPatchValue(patch, ['runwayCreditsCheckedAt', 'runway_credits_checked_at'], current.runwayCreditsCheckedAt ?? null),
      inflight: Math.max(Number(patch.inflight ?? current.inflight) || 0, 0),
      errorCount: Math.max(Number(patch.errorCount ?? patch.error_count ?? current.errorCount) || 0, 0),
      consecutiveErrorCount: Math.max(Number(patch.consecutiveErrorCount ?? patch.consecutive_error_count ?? current.consecutiveErrorCount) || 0, 0),
      lastError: pickPatchValue(patch, ['lastError', 'last_error'], current.lastError ?? null),
      lastAuthFailedAt: pickPatchValue(patch, ['lastAuthFailedAt', 'last_auth_failed_at'], current.lastAuthFailedAt ?? null),
      lastUsedAt: patch.lastUsedAt ?? patch.last_used_at ?? current.lastUsedAt ?? null,
      capturedAt: patch.capturedAt ?? patch.captured_at ?? current.capturedAt ?? (patch.jwt || patch.cookieHeader || patch.cookie_header || patch.cookie ? now : null),
      updatedAt: now
    });
    return this.getAccount(id, { includeSecret: true });
  }

  deleteAccount(id) {
    const result = this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    this.db.prepare('UPDATE tasks SET account_id = NULL WHERE account_id = ?').run(id);
    this.db.prepare('UPDATE assets SET account_id = NULL WHERE account_id = ?').run(id);
    return result.changes > 0;
  }

  setAccountActive(id, active) {
    return this.updateAccount(id, { isActive: active ? 1 : 0 });
  }

  resetAccountGenerationUsage(id) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE accounts SET generation_used = 0, generation_reset_at = @now, updated_at = @now
      WHERE id = @id
    `).run({ id, now });
    return result.changes ? this.getAccount(id) : null;
  }

  resetExpiredGenerationUsage(id = null, now = new Date()) {
    const resetAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const todayKey = quotaDayKey(resetAt);
    const where = id ? 'id = @id AND' : '';
    const initialized = this.db.prepare(`
      UPDATE accounts
      SET generation_reset_at = @resetAt, updated_at = @resetAt
      WHERE ${where}
        (generation_reset_at IS NULL OR generation_reset_at = '')
    `).run({ id, resetAt });
    const reset = this.db.prepare(`
      UPDATE accounts
      SET generation_used = 0, generation_reset_at = @resetAt, updated_at = @resetAt
      WHERE ${where}
        generation_reset_at IS NOT NULL
        AND generation_reset_at != ''
        AND (date(generation_reset_at, '+8 hours') IS NULL OR date(generation_reset_at, '+8 hours') < @todayKey)
    `).run({ id, resetAt, todayKey });
    return initialized.changes + reset.changes;
  }

  incrementGenerationUsed(id) {
    if (!id) return null;
    this.resetExpiredGenerationUsage(id);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE accounts SET generation_used = generation_used + 1, updated_at = @now
      WHERE id = @id
    `).run({ id, now });
    return this.getAccount(id, { includeSecret: true });
  }

  updateAccountCredits(id, credits) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE accounts
      SET runway_credits_json = @credits, runway_credits_checked_at = @now, updated_at = @now
      WHERE id = @id
    `).run({ id, credits: stringify(credits), now });
    return result.changes ? this.getAccount(id) : null;
  }

  upsertAccountCredentials(id, patch = {}) {
    const account = this.getAccount(id, { includeSecret: true }) || this.createAccount({ id, name: 'Runway 账号' });
    const next = this.updateAccount(account.id, {
      jwt: patch.jwt ?? account.jwt,
      cookieHeader: patch.cookieHeader ?? patch.cookie_header ?? patch.cookie ?? account.cookieHeader,
      teamId: patch.teamId ?? patch.team_id ?? account.teamId,
      assetGroupId: patch.assetGroupId ?? patch.asset_group_id ?? account.assetGroupId,
      clientId: patch.clientId ?? patch.client_id ?? account.clientId,
      sourceApplicationVersion:
        patch.sourceApplicationVersion ??
        patch.source_application_version ??
        account.sourceApplicationVersion,
      capturedAt: new Date().toISOString(),
      lastError: null,
      consecutiveErrorCount: 0
    });
    this.syncCredentialsFromAccount(next);
    return next;
  }

  upsertCredentials(patch) {
    const first = this.getFirstAccount({ includeSecret: true });
    const account = first || this.createAccount({ name: '迁移账号', remark: '由旧凭证接口创建' });
    const next = this.upsertAccountCredentials(account.id, patch);
    this.syncCredentialsFromAccount(next);
    return this.getCredentials();
  }

  syncCredentialsFromAccount(account) {
    if (!account) return;
    const row = {
      jwt: account.jwt || null,
      team_id: account.teamId || null,
      asset_group_id: account.assetGroupId || null,
      client_id: account.clientId || null,
      source_application_version: account.sourceApplicationVersion || null,
      captured_at: account.capturedAt || new Date().toISOString()
    };
    this.db.prepare(`
      INSERT INTO credentials (
        id, jwt, team_id, asset_group_id, client_id, source_application_version, captured_at
      ) VALUES (1, @jwt, @team_id, @asset_group_id, @client_id, @source_application_version, @captured_at)
      ON CONFLICT(id) DO UPDATE SET
        jwt = excluded.jwt,
        team_id = excluded.team_id,
        asset_group_id = excluded.asset_group_id,
        client_id = excluded.client_id,
        source_application_version = excluded.source_application_version,
        captured_at = excluded.captured_at
    `).run(row);
  }

  invalidateCredentials() {
    const account = this.getFirstAccount({ includeSecret: true });
    if (account) this.markAccountAuthFailed(account.id, 'AUTH_FAILED');
    this.db.prepare('UPDATE credentials SET jwt = NULL, captured_at = ? WHERE id = 1').run(new Date().toISOString());
  }

  getCredentials() {
    const account = this.getFirstAccount({ includeSecret: true });
    if (account) return accountToCredentialsRow(account);
    return this.db.prepare('SELECT * FROM credentials WHERE id = 1').get() || null;
  }

  getFirstAccount({ includeSecret = false } = {}) {
    this.resetExpiredGenerationUsage();
    const row = this.db.prepare(`
      SELECT accounts.*, proxies.name AS proxy_name, proxies.url AS proxy_url
      FROM accounts
      LEFT JOIN proxies ON proxies.id = accounts.proxy_id
      ORDER BY accounts.created_at ASC
      LIMIT 1
    `).get();
    return row ? hydrateAccount(row, { includeSecret }) : null;
  }

  getCredentialStatus() {
    const account = this.getFirstAccount({ includeSecret: true });
    const row = account ? accountToCredentialsRow(account) : this.getCredentials();
    return credentialStatus(row);
  }

  getAccountSummary() {
    this.resetExpiredGenerationUsage();
    const summary = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN is_active = 1 AND (jwt IS NOT NULL OR cookie_header IS NOT NULL) AND team_id IS NOT NULL THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN is_active = 1 AND inflight >= max_concurrent THEN 1 ELSE 0 END) AS full_concurrency,
        SUM(CASE WHEN is_active = 1 AND generation_used >= generation_limit THEN 1 ELSE 0 END) AS quota_exhausted,
        COALESCE(SUM(inflight), 0) AS inflight,
        COALESCE(SUM(generation_used), 0) AS generation_used,
        COALESCE(SUM(generation_limit), 0) AS generation_limit
      FROM accounts
    `).get();
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'pending'").get().count;
    return {
      total: summary.total || 0,
      active: summary.active || 0,
      ready: summary.ready || 0,
      fullConcurrency: summary.full_concurrency || 0,
      quotaExhausted: summary.quota_exhausted || 0,
      inflight: summary.inflight || 0,
      generationUsed: summary.generation_used || 0,
      generationLimit: summary.generation_limit || 0,
      generationRemaining: Math.max((summary.generation_limit || 0) - (summary.generation_used || 0), 0),
      pendingTasks: pending || 0
    };
  }

  createProxy(input = {}) {
    const now = new Date().toISOString();
    const normalized = normalizeProxyInput(input.url || input.proxy || input.value);
    const id = input.id || randomUUID();
    this.db.prepare(`
      INSERT INTO proxies (
        id, name, url, protocol, is_active, use_count, error_count, last_used_at,
        last_error, created_at, updated_at
      ) VALUES (
        @id, @name, @url, @protocol, @isActive, @useCount, @errorCount, @lastUsedAt,
        @lastError, @createdAt, @updatedAt
      )
    `).run({
      id,
      name: input.name || normalized.label,
      url: normalized.url,
      protocol: normalized.protocol,
      isActive: normalizeBooleanFlag(input.isActive ?? input.is_active, 1),
      useCount: normalizeNonNegativeInt(input.useCount ?? input.use_count, 0),
      errorCount: normalizeNonNegativeInt(input.errorCount ?? input.error_count, 0),
      lastUsedAt: input.lastUsedAt ?? input.last_used_at ?? null,
      lastError: input.lastError ?? input.last_error ?? null,
      createdAt: input.createdAt ?? input.created_at ?? now,
      updatedAt: now
    });
    return this.getProxy(id);
  }

  listProxies() {
    return this.db.prepare('SELECT * FROM proxies ORDER BY created_at ASC').all().map(hydrateProxy);
  }

  listActiveProxies() {
    return this.db.prepare(`
      SELECT * FROM proxies
      WHERE is_active = 1
      ORDER BY COALESCE(last_used_at, created_at) ASC, error_count ASC, use_count ASC
    `).all().map(hydrateProxy);
  }

  getProxy(id) {
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM proxies WHERE id = ?').get(id);
    return row ? hydrateProxy(row) : null;
  }

  updateProxy(id, patch = {}) {
    const current = this.getProxy(id);
    if (!current) return null;
    const normalized = patch.url || patch.proxy || patch.value
      ? normalizeProxyInput(patch.url || patch.proxy || patch.value)
      : { url: current.url, protocol: current.protocol, label: current.name };
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE proxies SET
        name = @name,
        url = @url,
        protocol = @protocol,
        is_active = @isActive,
        last_error = @lastError,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id,
      name: patch.name ?? current.name,
      url: normalized.url,
      protocol: normalized.protocol,
      isActive: normalizeBooleanFlag(patch.isActive ?? patch.is_active, current.isActive ? 1 : 0),
      lastError: patch.lastError ?? patch.last_error ?? current.lastError ?? null,
      updatedAt: now
    });
    return this.getProxy(id);
  }

  deleteProxy(id) {
    const result = this.db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
    this.db.prepare('UPDATE accounts SET proxy_id = NULL WHERE proxy_id = ?').run(id);
    return result.changes > 0;
  }

  setProxyActive(id, active) {
    return this.updateProxy(id, { isActive: active ? 1 : 0 });
  }

  recordProxyUse(id) {
    if (!id) return;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE proxies SET use_count = use_count + 1, last_used_at = @now, updated_at = @now
      WHERE id = @id
    `).run({ id, now });
  }

  recordProxyError(id, message) {
    if (!id) return;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE proxies SET error_count = error_count + 1, last_error = @message, updated_at = @now
      WHERE id = @id
    `).run({ id, message: String(message || 'proxy failed').slice(0, 1000), now });
  }

  getProxySummary() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active
      FROM proxies
    `).get();
    return { total: row.total || 0, active: row.active || 0 };
  }

  getReadyAccounts({ includeSecret = true } = {}) {
    this.resetExpiredGenerationUsage();
    const rows = this.db.prepare(`
      SELECT accounts.*, proxies.name AS proxy_name, proxies.url AS proxy_url
      FROM accounts
      LEFT JOIN proxies ON proxies.id = accounts.proxy_id
      WHERE accounts.is_active = 1
        AND (accounts.jwt IS NOT NULL OR accounts.cookie_header IS NOT NULL)
        AND accounts.team_id IS NOT NULL
        AND accounts.generation_used < accounts.generation_limit
      ORDER BY (inflight + (
        SELECT COUNT(*) FROM tasks
        WHERE tasks.account_id = accounts.id AND tasks.status = 'pending'
      )) ASC,
      CASE WHEN accounts.last_used_at IS NULL THEN 0 ELSE 1 END ASC,
      CASE WHEN accounts.last_used_at IS NULL THEN RANDOM() ELSE 0 END,
      accounts.last_used_at ASC,
      RANDOM()
    `).all();
    return rows.map((row) => hydrateAccount(row, { includeSecret }));
  }

  selectLeastLoadedAccount({ preferredAccountId = null } = {}) {
    this.resetExpiredGenerationUsage(preferredAccountId);
    const candidates = preferredAccountId
      ? [this.getAccount(preferredAccountId, { includeSecret: true })].filter(Boolean)
      : this.getReadyAccounts({ includeSecret: true });
    for (const account of candidates) {
      if (!isReadyAccount(account)) continue;
      const inflight = Number(account.inflight) || 0;
      const maxConcurrent = normalizeConcurrency(account.maxConcurrent);
      if (inflight >= maxConcurrent) continue;
      return account;
    }
    return null;
  }

  acquireAccountForTask(taskId, { preferredAccountId = null } = {}) {
    const account = this.selectLeastLoadedAccount({ preferredAccountId });
    if (!account) return null;
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE accounts
      SET inflight = inflight + 1, last_used_at = @now, updated_at = @now
      WHERE id = @id
        AND is_active = 1
        AND (jwt IS NOT NULL OR cookie_header IS NOT NULL)
        AND team_id IS NOT NULL
        AND inflight < max_concurrent
        AND generation_used < generation_limit
    `).run({ id: account.id, now });
    if (result.changes === 0) return null;
    this.db.prepare('UPDATE tasks SET account_id = ?, updated_at = ? WHERE id = ?').run(account.id, now, taskId);
    this.db.prepare('UPDATE assets SET account_id = ?, updated_at = ? WHERE task_id = ?').run(account.id, now, taskId);
    return this.getAccount(account.id, { includeSecret: true });
  }

  releaseAccount(accountId) {
    if (!accountId) return;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE accounts
      SET inflight = CASE WHEN inflight > 0 THEN inflight - 1 ELSE 0 END, updated_at = ?
      WHERE id = ?
    `).run(now, accountId);
  }

  markAccountAuthFailed(accountId, message = 'Runway auth failed') {
    if (!accountId) return;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE accounts SET
        is_active = 0,
        jwt = NULL,
        cookie_header = NULL,
        error_count = error_count + 1,
        consecutive_error_count = consecutive_error_count + 1,
        last_error = @message,
        last_auth_failed_at = @now,
        updated_at = @now
      WHERE id = @accountId
    `).run({ accountId, message, now });
    this.logRequest({ accountId, operation: 'auth', status: 'failed', statusCode: 401, message });
  }

  markAccountError(accountId, message) {
    if (!accountId) return;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE accounts SET
        error_count = error_count + 1,
        consecutive_error_count = consecutive_error_count + 1,
        last_error = @message,
        updated_at = @now
      WHERE id = @accountId
    `).run({ accountId, message, now });
  }

  markAccountSuccess(accountId) {
    if (!accountId) return;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE accounts SET consecutive_error_count = 0, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, accountId);
  }

  rebuildAccountInflight() {
    this.db.prepare('UPDATE accounts SET inflight = 0').run();
    const rows = this.db.prepare(`
      SELECT account_id, COUNT(*) AS count
      FROM tasks
      WHERE account_id IS NOT NULL AND status IN ('submitting', 'queuing', 'generating')
      GROUP BY account_id
    `).all();
    const stmt = this.db.prepare('UPDATE accounts SET inflight = ? WHERE id = ?');
    for (const row of rows) stmt.run(row.count, row.account_id);
  }

  createTask(task) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO tasks (
        id, parent_task_id, account_id, runway_task_id, status, raw_status, prompt, model, duration,
        resolution, aspect_ratio, generate_audio, explore_mode, progress, video_url,
        thumbnail_url, error, raw_response, created_at, updated_at, submitted_at, completed_at
      ) VALUES (
        @id, @parentTaskId, @accountId, @runwayTaskId, @status, @rawStatus, @prompt, @model, @duration,
        @resolution, @aspectRatio, @generateAudio, @exploreMode, @progress, @videoUrl,
        @thumbnailUrl, @error, @rawResponse, @createdAt, @updatedAt, @submittedAt, @completedAt
      )
    `).run({
      id: task.id,
      parentTaskId: task.parentTaskId || null,
      accountId: task.accountId || null,
      runwayTaskId: task.runwayTaskId || null,
      status: task.status || 'pending',
      rawStatus: task.rawStatus || null,
      prompt: task.prompt,
      model: task.model,
      duration: task.duration,
      resolution: task.resolution,
      aspectRatio: task.aspectRatio,
      generateAudio: task.generateAudio ? 1 : 0,
      exploreMode: task.exploreMode ? 1 : 0,
      progress: task.progress ?? null,
      videoUrl: task.videoUrl || null,
      thumbnailUrl: task.thumbnailUrl || null,
      error: task.error ? stringify(task.error) : null,
      rawResponse: task.rawResponse ? stringify(task.rawResponse) : null,
      createdAt: now,
      updatedAt: now,
      submittedAt: task.submittedAt || null,
      completedAt: task.completedAt || null
    });
    this.addTaskEvent(task.id, {
      accountId: task.accountId || null,
      type: 'queued',
      message: '任务已入队',
      data: { model: task.model, duration: task.duration, resolution: task.resolution }
    });
    return this.getTask(task.id);
  }

  addAsset(asset) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO assets (
        id, task_id, account_id, local_path, filename, mime_type, media_type, size, runway_asset_id,
        runway_url, preview_url, created_at, updated_at
      ) VALUES (
        @id, @taskId, @accountId, @localPath, @filename, @mimeType, @mediaType, @size, @runwayAssetId,
        @runwayUrl, @previewUrl, @createdAt, @updatedAt
      )
    `).run({
      id: asset.id,
      taskId: asset.taskId,
      accountId: asset.accountId || null,
      localPath: asset.localPath,
      filename: asset.filename,
      mimeType: asset.mimeType || null,
      mediaType: asset.mediaType || null,
      size: asset.size,
      runwayAssetId: asset.runwayAssetId || null,
      runwayUrl: asset.runwayUrl || null,
      previewUrl: asset.previewUrl || null,
      createdAt: now,
      updatedAt: now
    });
    return this.getAsset(asset.id);
  }

  updateAsset(id, patch) {
    const current = this.getAsset(id);
    if (!current) return null;
    this.db.prepare(`
      UPDATE assets SET
        account_id = @accountId,
        runway_asset_id = @runwayAssetId,
        runway_url = @runwayUrl,
        preview_url = @previewUrl,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id,
      accountId: patch.accountId ?? patch.account_id ?? current.account_id,
      runwayAssetId: patch.runwayAssetId ?? current.runway_asset_id,
      runwayUrl: patch.runwayUrl ?? current.runway_url,
      previewUrl: patch.previewUrl ?? current.preview_url,
      updatedAt: new Date().toISOString()
    });
    return this.getAsset(id);
  }

  updateTask(id, patch) {
    const current = this.getTask(id);
    if (!current) return null;
    const previousStatus = current.status;
    const status = patch.status ?? current.status;
    const completedAt = TERMINAL_STATUSES.has(status)
      ? (patch.completedAt ?? current.completedAt ?? new Date().toISOString())
      : (patch.completedAt ?? current.completedAt ?? null);
    this.db.prepare(`
      UPDATE tasks SET
        account_id = @accountId,
        runway_task_id = @runwayTaskId,
        status = @status,
        raw_status = @rawStatus,
        progress = @progress,
        video_url = @videoUrl,
        thumbnail_url = @thumbnailUrl,
        error = @error,
        raw_response = @rawResponse,
        updated_at = @updatedAt,
        submitted_at = @submittedAt,
        completed_at = @completedAt
      WHERE id = @id
    `).run({
      id,
      accountId: patch.accountId ?? patch.account_id ?? current.accountId ?? null,
      runwayTaskId: patch.runwayTaskId ?? current.runwayTaskId,
      status,
      rawStatus: patch.rawStatus ?? current.rawStatus,
      progress: patch.progress ?? current.progress,
      videoUrl: patch.videoUrl ?? current.videoUrl,
      thumbnailUrl: patch.thumbnailUrl ?? current.thumbnailUrl,
      error: patch.error === undefined ? stringify(current.error) : stringify(patch.error),
      rawResponse: patch.rawResponse === undefined ? stringify(current.rawResponse) : stringify(patch.rawResponse),
      updatedAt: new Date().toISOString(),
      submittedAt: patch.submittedAt ?? current.submittedAt,
      completedAt
    });
    if (current.accountId && ACTIVE_STATUSES.has(previousStatus) && TERMINAL_STATUSES.has(status)) {
      this.releaseAccount(current.accountId);
    }
    if (status !== previousStatus) {
      this.addTaskEvent(id, {
        accountId: patch.accountId ?? patch.account_id ?? current.accountId ?? null,
        type: `status:${status}`,
        message: `任务状态变更为 ${status}`,
        data: {
          previousStatus,
          status,
          rawStatus: patch.rawStatus ?? current.rawStatus,
          error: patch.error === undefined ? current.error : patch.error
        }
      });
    }
    return this.getTask(id);
  }

  cancelTask(id, { reason = '用户取消任务', runwayResponse = null, runwayError = null } = {}) {
    const task = this.getTask(id);
    if (!task) return null;
    if (TERMINAL_STATUSES.has(task.status)) return task;
    const cancelled = this.updateTask(id, {
      status: 'cancelled',
      rawStatus: task.rawStatus || 'CANCELLED',
      error: {
        code: 'USER_CANCELLED',
        message: reason,
        runwayResponse,
        runwayError
      },
      completedAt: new Date().toISOString()
    });
    this.clearTaskLease(id);
    this.addTaskEvent(id, {
      accountId: task.accountId,
      type: 'cancelled',
      message: reason,
      data: {
        runwayTaskId: task.runwayTaskId,
        runwayResponse,
        runwayError
      }
    });
    return cancelled;
  }

  getTask(id) {
    const row = this.db.prepare(`
      SELECT tasks.*, accounts.name AS account_name
      FROM tasks
      LEFT JOIN accounts ON accounts.id = tasks.account_id
      WHERE tasks.id = ?
    `).get(id);
    return row ? hydrateTask(row, this.getAssetsByTask(id)) : null;
  }

  listTasks({ status, limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const rows = status
      ? this.db.prepare(`
          SELECT tasks.*, accounts.name AS account_name
          FROM tasks
          LEFT JOIN accounts ON accounts.id = tasks.account_id
          WHERE tasks.status = ?
          ORDER BY tasks.created_at DESC LIMIT ? OFFSET ?
        `).all(status, safeLimit, safeOffset)
      : this.db.prepare(`
          SELECT tasks.*, accounts.name AS account_name
          FROM tasks
          LEFT JOIN accounts ON accounts.id = tasks.account_id
          ORDER BY tasks.created_at DESC LIMIT ? OFFSET ?
        `).all(safeLimit, safeOffset);
    return rows.map((row) => hydrateTask(row, this.getAssetsByTask(row.id)));
  }

  getNextPendingTasks(limit) {
    const rows = this.db.prepare(`
      SELECT tasks.*, accounts.name AS account_name
      FROM tasks
      LEFT JOIN accounts ON accounts.id = tasks.account_id
      WHERE tasks.status = 'pending'
      ORDER BY tasks.created_at ASC
      LIMIT ?
    `).all(limit);
    return rows.map((row) => hydrateTask(row, this.getAssetsByTask(row.id)));
  }

  getActiveRunwayTasks() {
    const rows = this.db.prepare(`
      SELECT tasks.*, accounts.name AS account_name
      FROM tasks
      LEFT JOIN accounts ON accounts.id = tasks.account_id
      WHERE tasks.runway_task_id IS NOT NULL AND tasks.status IN ('queuing', 'generating', 'submitting')
      ORDER BY tasks.updated_at ASC
    `).all();
    return rows.map((row) => hydrateTask(row, this.getAssetsByTask(row.id)));
  }

  leasePendingTasks({ limit = 10, workerId, leaseMs = 120000 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 200);
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - leaseMs).toISOString();
    const rows = this.db.prepare(`
      SELECT id FROM tasks
      WHERE status = 'pending'
        AND (locked_at IS NULL OR locked_at < ?)
      ORDER BY created_at ASC
      LIMIT ?
    `).all(cutoff, safeLimit);
    const leased = [];
    const tx = this.db.transaction((ids) => {
      for (const row of ids) {
        const result = this.db.prepare(`
          UPDATE tasks SET
            locked_by = @workerId,
            locked_at = @now,
            last_heartbeat_at = @now,
            attempt_count = attempt_count + 1,
            updated_at = @now
          WHERE id = @id
            AND status = 'pending'
            AND (locked_at IS NULL OR locked_at < @cutoff)
        `).run({ id: row.id, workerId, now, cutoff });
        if (result.changes) {
          this.addTaskEvent(row.id, {
            type: 'leased',
            message: `任务已被 worker ${workerId} 领取`,
            data: { workerId }
          });
          leased.push(row.id);
        }
      }
    });
    tx(rows);
    return leased.map((id) => this.getTask(id)).filter(Boolean);
  }

  heartbeatTaskLease(taskId, workerId) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE tasks SET last_heartbeat_at = @now, updated_at = @now
      WHERE id = @taskId AND locked_by = @workerId
    `).run({ taskId, workerId, now });
  }

  clearTaskLease(taskId, workerId = null) {
    const now = new Date().toISOString();
    const result = workerId
      ? this.db.prepare(`
          UPDATE tasks SET locked_by = NULL, locked_at = NULL, last_heartbeat_at = NULL, updated_at = @now
          WHERE id = @taskId AND locked_by = @workerId
        `).run({ taskId, workerId, now })
      : this.db.prepare(`
          UPDATE tasks SET locked_by = NULL, locked_at = NULL, last_heartbeat_at = NULL, updated_at = @now
          WHERE id = @taskId
        `).run({ taskId, now });
    return result.changes > 0;
  }

  recoverStaleLeases(leaseMs = 120000) {
    const cutoff = new Date(Date.now() - leaseMs).toISOString();
    const now = new Date().toISOString();
    const stale = this.db.prepare(`
      SELECT id, locked_by FROM tasks
      WHERE status = 'pending' AND locked_at IS NOT NULL AND locked_at < ?
    `).all(cutoff);
    const result = this.db.prepare(`
      UPDATE tasks SET locked_by = NULL, locked_at = NULL, last_heartbeat_at = NULL, updated_at = @now
      WHERE status = 'pending' AND locked_at IS NOT NULL AND locked_at < @cutoff
    `).run({ now, cutoff });
    for (const task of stale) {
      this.addTaskEvent(task.id, {
        type: 'lease_recovered',
        message: '已恢复过期任务锁',
        data: { previousWorkerId: task.locked_by }
      });
    }
    return result.changes || 0;
  }

  recoverStaleActiveTasks(timeoutMs = 1800000) {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    const now = new Date().toISOString();
    const rows = this.db.prepare(`
      SELECT id, status, runway_task_id, last_heartbeat_at, updated_at
      FROM tasks
      WHERE status IN ('submitting', 'queuing', 'generating')
        AND COALESCE(last_heartbeat_at, updated_at) < ?
    `).all(cutoff);
    for (const row of rows) {
      if (row.runway_task_id) {
        this.updateTask(row.id, {
          status: row.status === 'submitting' ? 'queuing' : row.status,
          error: null
        });
        this.clearTaskLease(row.id);
        this.addTaskEvent(row.id, {
          type: 'stale_recovered',
          message: '活跃任务心跳过期，已恢复轮询',
          data: row
        });
      } else {
        this.updateTask(row.id, {
          status: 'pending',
          error: { code: 'STALE_SUBMIT_RECOVERED', message: '提交阶段心跳过期，已重新入队' }
        });
        this.clearTaskLease(row.id);
        this.addTaskEvent(row.id, {
          type: 'stale_requeued',
          message: '提交阶段心跳过期，已重新入队',
          data: row
        });
      }
    }
    if (rows.length) this.rebuildAccountInflight();
    this.db.prepare('UPDATE accounts SET updated_at = ? WHERE inflight < 0').run(now);
    return rows.length;
  }

  recoverTimedOutTasks(timeoutMs = 1500000) {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    const rows = this.db.prepare(`
      SELECT id, account_id, status, runway_task_id, submitted_at, updated_at
      FROM tasks
      WHERE status IN ('submitting', 'generating')
        AND COALESCE(submitted_at, updated_at) < ?
    `).all(cutoff);
    for (const row of rows) {
      this.updateTask(row.id, {
        status: 'failed',
        error: {
          code: 'TASK_TIMEOUT',
          message: '任务超过配置的最大运行时间',
          raw: row
        }
      });
      this.clearTaskLease(row.id);
      this.addTaskEvent(row.id, {
        accountId: row.account_id,
        type: 'task_timeout',
        message: '任务超过配置的最大运行时间，已标记失败',
        data: row
      });
    }
    if (rows.length) this.rebuildAccountInflight();
    return rows.length;
  }

  addTaskEvent(taskId, { accountId = null, type, message = null, data = null } = {}) {
    if (!taskId || !type) return;
    this.db.prepare(`
      INSERT INTO task_events (id, task_id, account_id, type, message, data, created_at)
      VALUES (@id, @taskId, @accountId, @type, @message, @data, @createdAt)
    `).run({
      id: randomUUID(),
      taskId,
      accountId,
      type,
      message,
      data: data == null ? null : stringify(data),
      createdAt: new Date().toISOString()
    });
  }

  getTaskEvents(taskId) {
    const events = this.db.prepare(`
      SELECT task_events.*, accounts.name AS account_name
      FROM task_events
      LEFT JOIN accounts ON accounts.id = task_events.account_id
      WHERE task_events.task_id = ?
      ORDER BY task_events.created_at ASC
    `).all(taskId).map((row) => ({
      id: row.id,
      taskId: row.task_id,
      accountId: row.account_id,
      accountName: row.account_name || null,
      type: row.type,
      message: row.message,
      data: parseJson(row.data),
      createdAt: row.created_at
    }));
    if (events.length) return events;
    return this.getSyntheticTaskEvents(taskId);
  }

  getSyntheticTaskEvents(taskId) {
    const row = this.db.prepare(`
      SELECT tasks.*, accounts.name AS account_name
      FROM tasks
      LEFT JOIN accounts ON accounts.id = tasks.account_id
      WHERE tasks.id = ?
    `).get(taskId);
    if (!row) return [];
    const events = [];
    const push = (type, message, createdAt, data = {}) => {
      if (!createdAt) return;
      events.push({
        id: `${taskId}:${type}`,
        taskId,
        accountId: row.account_id,
        accountName: row.account_name || null,
        type,
        message,
        data,
        createdAt
      });
    };
    push('queued', '任务已入队', row.created_at, {
      model: row.model,
      duration: row.duration,
      resolution: row.resolution
    });
    if (row.account_id) {
      push('account_assigned', '任务已绑定账号', row.submitted_at || row.updated_at, {
        accountId: row.account_id,
        accountName: row.account_name || null
      });
    }
    if (row.runway_task_id) {
      push('submitted', '任务已提交到 Runway', row.submitted_at || row.updated_at, {
        runwayTaskId: row.runway_task_id,
        rawStatus: row.raw_status
      });
    }
    if (TERMINAL_STATUSES.has(row.status)) {
      push(`status:${row.status}`, `任务状态变更为 ${row.status}`, row.completed_at || row.updated_at, {
        status: row.status,
        rawStatus: row.raw_status,
        error: parseJson(row.error)
      });
    }
    return events.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  getQueueSummary({ leaseMs = 120000 } = {}) {
    const cutoff = new Date(Date.now() - leaseMs).toISOString();
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN locked_at IS NOT NULL AND status = 'pending' THEN 1 ELSE 0 END) AS leased,
        SUM(CASE WHEN locked_at IS NOT NULL AND status = 'pending' AND locked_at < @cutoff THEN 1 ELSE 0 END) AS stale,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM tasks
    `).get({ cutoff });
    const oldest = this.db.prepare("SELECT created_at FROM tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1").get();
    return {
      pending: row.pending || 0,
      leased: row.leased || 0,
      stale: row.stale || 0,
      failed: row.failed || 0,
      oldestPendingAt: oldest?.created_at || null,
      queueDelayMs: oldest?.created_at ? Math.max(Date.now() - Date.parse(oldest.created_at), 0) : 0
    };
  }

  getRecentAuthFailedAccounts({ limit = 5 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 20);
    return this.db.prepare(`
      SELECT id, name, last_auth_failed_at, last_error
      FROM accounts
      WHERE last_auth_failed_at IS NOT NULL
      ORDER BY last_auth_failed_at DESC
      LIMIT ?
    `).all(safeLimit).map((row) => ({
      id: row.id,
      name: row.name,
      lastAuthFailedAt: row.last_auth_failed_at,
      lastError: row.last_error
    }));
  }

  getAsset(id) {
    return this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) || null;
  }

  getAssetsByTask(taskId) {
    return this.db.prepare('SELECT * FROM assets WHERE task_id = ? ORDER BY created_at ASC').all(taskId);
  }

  logRequest({
    accountId = null,
    proxyId = null,
    operation,
    status,
    statusCode = null,
    durationMs = null,
    message = null,
    requestBody = null,
    responseBody = null
  }) {
    const now = new Date().toISOString();
    const runtime = this.getRuntimeConfig();
    this.db.prepare(`
      INSERT INTO request_logs (
        id, account_id, proxy_id, operation, status, status_code, duration_ms,
        message, request_body, response_body, created_at
      ) VALUES (
        @id, @accountId, @proxyId, @operation, @status, @statusCode, @durationMs,
        @message, @requestBody, @responseBody, @createdAt
      )
    `).run({
      id: randomUUID(),
      accountId,
      proxyId,
      operation,
      status,
      statusCode,
      durationMs,
      message: message ? String(message).slice(0, 2000) : null,
      requestBody: runtime.logRequestBody ? maskMaybe(stringify(requestBody), runtime.maskSecrets) : null,
      responseBody: runtime.logResponseBody ? maskMaybe(stringify(responseBody), runtime.maskSecrets) : null,
      createdAt: now
    });
  }

  listRequestLogs({ limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.db.prepare(`
      SELECT request_logs.*, accounts.name AS account_name, proxies.name AS proxy_name
      FROM request_logs
      LEFT JOIN accounts ON accounts.id = request_logs.account_id
      LEFT JOIN proxies ON proxies.id = request_logs.proxy_id
      ORDER BY request_logs.created_at DESC
      LIMIT ?
    `).all(safeLimit).map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountName: row.account_name,
      proxyId: row.proxy_id,
      proxyName: row.proxy_name,
      operation: row.operation,
      status: row.status,
      statusCode: row.status_code,
      durationMs: row.duration_ms,
      message: row.message,
      createdAt: row.created_at
    }));
  }

  getRequestLog(id) {
    const row = this.db.prepare(`
      SELECT request_logs.*, accounts.name AS account_name, proxies.name AS proxy_name
      FROM request_logs
      LEFT JOIN accounts ON accounts.id = request_logs.account_id
      LEFT JOIN proxies ON proxies.id = request_logs.proxy_id
      WHERE request_logs.id = ?
    `).get(id);
    return row ? hydrateRequestLog(row) : null;
  }

  clearRequestLogs() {
    this.db.prepare('DELETE FROM request_logs').run();
  }

  pruneRequestLogs({ retentionDays = 14, maxRows = 10000 } = {}) {
    const safeDays = normalizeNonNegativeInt(retentionDays, 14);
    if (safeDays > 0) {
      const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare('DELETE FROM request_logs WHERE created_at < ?').run(cutoff);
    }
    const safeMaxRows = Math.max(Number(maxRows) || 10000, 100);
    this.db.prepare(`
      DELETE FROM request_logs
      WHERE id IN (
        SELECT id FROM request_logs
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      )
    `).run(safeMaxRows);
  }

  cleanupUploadFiles({ retentionDays = 7 } = {}) {
    const safeDays = normalizeNonNegativeInt(retentionDays, 7);
    if (safeDays <= 0) return { deleted: 0 };
    const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      SELECT assets.id, assets.local_path
      FROM assets
      JOIN tasks ON tasks.id = assets.task_id
      WHERE tasks.status IN ('completed', 'failed', 'cancelled')
        AND tasks.completed_at IS NOT NULL
        AND tasks.completed_at < ?
    `).all(cutoff);
    let deleted = 0;
    for (const row of rows) {
      if (!row.local_path) continue;
      try {
        if (fs.existsSync(row.local_path)) {
          fs.unlinkSync(row.local_path);
          deleted += 1;
        }
      } catch {}
    }
    return { deleted };
  }
}

function stringify(value) {
  if (value == null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeConcurrency(value) {
  return Math.max(Number.parseInt(value, 10) || 2, 1);
}

function normalizeNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeOptionalNonNegativeInt(value) {
  if (value == null || value === '') return null;
  return normalizeNonNegativeInt(value, 0);
}

function normalizeGenerationLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 80;
}

function quotaDayKey(value = new Date()) {
  return new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function normalizeBooleanFlag(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback ? 1 : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled', '启用'].includes(normalized)) return 1;
  if (['0', 'false', 'no', 'off', 'disabled', '停用'].includes(normalized)) return 0;
  return fallback ? 1 : 0;
}

function normalizeMs(value, fallback, min = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function normalizeOptionalMs(value) {
  if (value == null || value === '') return null;
  return normalizeMs(value, null, 1000);
}

function normalizeRetryBackoff(value) {
  const raw = Array.isArray(value) ? value : parseJson(value);
  const list = Array.isArray(raw) ? raw : [1000, 3000, 7000];
  const normalized = list.map((item) => normalizeNonNegativeInt(item, 0)).filter((item) => item > 0);
  return JSON.stringify(normalized.length ? normalized : [1000, 3000, 7000]);
}

function normalizeProxyStrategy(value) {
  const strategy = String(value || 'fixed').trim();
  return ['fixed', 'per_request', 'on_failure'].includes(strategy) ? strategy : 'fixed';
}

function toDbBool(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;
  if (value == null || value === '') return 0;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()) ? 1 : 0;
}

function pickPatchValue(patch, keys, fallback) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) return patch[key];
  }
  return fallback;
}

function isReadyAccount(account) {
  return Boolean(
    account?.isActive &&
    (account.jwt || account.cookieHeader) &&
    account.teamId &&
    Number(account.generationUsed || 0) < Number(account.generationLimit || 0)
  );
}

function accountToCredentialsRow(account) {
  return {
    id: 1,
    jwt: account.jwt || null,
    cookie_header: account.cookieHeader || null,
    team_id: account.teamId || null,
    asset_group_id: account.assetGroupId || null,
    client_id: account.clientId || null,
    source_application_version: account.sourceApplicationVersion || null,
    captured_at: account.capturedAt || null
  };
}

function credentialStatus(row) {
  return {
    ready: Boolean(row?.jwt && row?.team_id),
    hasJwt: Boolean(row?.jwt),
    hasCookie: Boolean(row?.cookie_header),
    hasTeamId: Boolean(row?.team_id),
    hasAssetGroupId: Boolean(row?.asset_group_id),
    hasClientId: Boolean(row?.client_id),
    hasSourceApplicationVersion: Boolean(row?.source_application_version),
    teamId: row?.team_id ?? null,
    assetGroupId: row?.asset_group_id ?? null,
    capturedAt: row?.captured_at ?? null
  };
}

function hydrateAccount(row, { includeSecret = false } = {}) {
  const hasJwt = Boolean(row.jwt);
  const hasCookie = Boolean(row.cookie_header);
  const generationLimit = normalizeGenerationLimit(row.generation_limit);
  const generationUsed = normalizeNonNegativeInt(row.generation_used, 0);
  return {
    id: row.id,
    name: row.name,
    remark: row.remark,
    jwt: includeSecret ? row.jwt : undefined,
    cookieHeader: includeSecret ? row.cookie_header : undefined,
    hasJwt,
    hasCookie,
    teamId: row.team_id,
    assetGroupId: row.asset_group_id,
    clientId: row.client_id,
    sourceApplicationVersion: row.source_application_version,
    isActive: Boolean(row.is_active),
    maxConcurrent: row.max_concurrent,
    proxyId: row.proxy_id,
    proxyName: row.proxy_name || null,
    proxyUrl: row.proxy_url || null,
    proxyStrategy: normalizeProxyStrategy(row.proxy_strategy),
    generationLimit,
    generationUsed,
    generationRemaining: Math.max(generationLimit - generationUsed, 0),
    generationResetAt: row.generation_reset_at,
    requestTimeoutMs: row.request_timeout_ms,
    uploadTimeoutMs: row.upload_timeout_ms,
    taskTimeoutMs: row.task_timeout_ms,
    maxRetries: row.max_retries,
    runwayCredits: parseJson(row.runway_credits_json),
    runwayCreditsCheckedAt: row.runway_credits_checked_at,
    inflight: row.inflight,
    errorCount: row.error_count,
    consecutiveErrorCount: row.consecutive_error_count,
    lastError: row.last_error,
    lastAuthFailedAt: row.last_auth_failed_at,
    lastUsedAt: row.last_used_at,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ready: Boolean(row.is_active && (row.jwt || row.cookie_header) && row.team_id && generationUsed < generationLimit)
  };
}

function hydrateProxy(row) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    protocol: row.protocol,
    isActive: Boolean(row.is_active),
    useCount: row.use_count,
    errorCount: row.error_count,
    lastUsedAt: row.last_used_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hydrateRuntimeConfig(row) {
  return {
    requestTimeoutMs: row.request_timeout_ms,
    uploadTimeoutMinMs: row.upload_timeout_min_ms,
    uploadTimeoutMaxMs: row.upload_timeout_max_ms,
    taskTimeoutMs: row.task_timeout_ms,
    maxRetries: row.max_retries,
    defaultGenerationLimit: row.default_generation_limit,
    retryBackoffMs: parseJson(row.retry_backoff_ms) || [1000, 3000, 7000],
    proxyStrategyDefault: normalizeProxyStrategy(row.proxy_strategy_default),
    forceProxy: Boolean(row.force_proxy),
    logRequestBody: Boolean(row.log_request_body),
    logResponseBody: Boolean(row.log_response_body),
    maskSecrets: Boolean(row.mask_secrets),
    queueLeaseTimeoutMs: row.queue_lease_timeout_ms,
    staleTaskTimeoutMs: row.stale_task_timeout_ms,
    logRetentionDays: row.log_retention_days,
    uploadRetentionDays: row.upload_retention_days,
    updatedAt: row.updated_at
  };
}

function hydrateRequestLog(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name || null,
    proxyId: row.proxy_id,
    proxyName: row.proxy_name || null,
    operation: row.operation,
    status: row.status,
    statusCode: row.status_code,
    durationMs: row.duration_ms,
    message: row.message,
    requestBody: parseJson(row.request_body),
    responseBody: parseJson(row.response_body),
    createdAt: row.created_at
  };
}

function normalizeProxyInput(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    const err = new Error('proxy url is required');
    err.statusCode = 400;
    throw err;
  }
  const st5 = /^st5\s+/i.test(raw);
  const cleaned = raw.replace(/^st5\s+/i, '');
  let url = cleaned;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const parts = url.split(':');
    if (parts.length === 2) {
      url = `${st5 ? 'socks5' : 'http'}://${parts[0]}:${parts[1]}`;
    } else if (parts.length === 4) {
      const [host, port, user, pass] = parts;
      url = `${st5 ? 'socks5' : 'http'}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    } else {
      const err = new Error('invalid proxy format');
      err.statusCode = 400;
      throw err;
    }
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    const err = new Error('invalid proxy url');
    err.statusCode = 400;
    throw err;
  }
  const protocol = parsed.protocol.replace(':', '').toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol)) {
    const err = new Error('unsupported proxy protocol');
    err.statusCode = 400;
    throw err;
  }
  if (!parsed.hostname || !parsed.port) {
    const err = new Error('proxy host and port are required');
    err.statusCode = 400;
    throw err;
  }
  return {
    url: parsed.toString(),
    protocol,
    label: `${protocol}://${parsed.hostname}:${parsed.port}`
  };
}

function maskMaybe(value, enabled = true) {
  if (!enabled || !value) return value;
  return String(value)
    .replace(/(authorization["']?\s*[:=]\s*["']?Bearer\s+)[^"',\s}]+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1***')
    .replace(/(cookie["']?\s*[:=]\s*["']?)[^"'}]+/gi, '$1***')
    .replace(/(jwt["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1***');
}

function hydrateTask(row, assets = []) {
  const error = parseJson(row.error);
  const normalizedError = error ? normalizeTaskError(error, row.raw_status) : {};
  return {
    id: row.id,
    parentTaskId: row.parent_task_id,
    accountId: row.account_id,
    accountName: row.account_name || null,
    runwayTaskId: row.runway_task_id,
    status: row.status,
    rawStatus: row.raw_status,
    prompt: row.prompt,
    model: row.model,
    duration: row.duration,
    resolution: row.resolution,
    aspectRatio: row.aspect_ratio,
    generateAudio: Boolean(row.generate_audio),
    exploreMode: Boolean(row.explore_mode),
    progress: row.progress,
    videoUrl: row.video_url,
    thumbnailUrl: row.thumbnail_url,
    error,
    errorSummary: normalizedError.errorSummary || null,
    errorCode: normalizedError.errorCode || null,
    errorCategory: normalizedError.errorCategory || null,
    errorMessage: normalizedError.errorMessage || null,
    errorReason: normalizedError.errorReason || null,
    errorDetail: normalizedError.errorDetail || null,
    rawResponse: parseJson(row.raw_response),
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    attemptCount: row.attempt_count || 0,
    lastHeartbeatAt: row.last_heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    assets: assets.map((asset) => ({
      id: asset.id,
      taskId: asset.task_id,
      accountId: asset.account_id,
      localPath: asset.local_path,
      filename: asset.filename,
      mimeType: asset.mime_type,
      mediaType: asset.media_type || inferMediaType(asset.mime_type, asset.filename),
      size: asset.size,
      runwayAssetId: asset.runway_asset_id,
      runwayUrl: asset.runway_url,
      previewUrl: asset.preview_url,
      createdAt: asset.created_at,
      updatedAt: asset.updated_at
    }))
  };
}

function inferMediaType(mimeType, filename) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  const ext = path.extname(filename || '').toLowerCase();
  if (['.mp4', '.mov', '.webm', '.m4v'].includes(ext)) return 'video';
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return 'image';
  return null;
}
