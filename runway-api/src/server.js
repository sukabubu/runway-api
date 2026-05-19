import fs from 'node:fs';
import { loadConfig } from './config.js';
import { RunwayDatabase } from './db.js';
import { RunwayBrowser } from './browser.js';
import { RunwayClient } from './runway/client.js';
import { TaskWorker } from './worker.js';
import { buildApp } from './app.js';
import { ProxyManager } from './proxy-manager.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new RunwayDatabase(config.dbPath, {
  dbPath: config.dbPath,
  browserProfilesDir: config.browserProfilesDir,
  adminUsername: config.adminUsername,
  adminPassword: config.adminPassword,
  internalApiKey: config.internalApiKey,
  defaultAccountConcurrency: config.defaultAccountConcurrency,
  requestTimeoutMs: config.requestTimeoutMs,
  uploadTimeoutMinMs: config.uploadTimeoutMinMs,
  uploadTimeoutMaxMs: config.uploadTimeoutMaxMs,
  taskTimeoutMs: config.taskTimeoutMs,
  maxRetries: config.maxRetries,
  queueLeaseTimeoutMs: config.queueLeaseTimeoutMs,
  staleTaskTimeoutMs: config.staleTaskTimeoutMs,
  logRetentionDays: config.logRetentionDays,
  uploadRetentionDays: config.uploadRetentionDays
});
const logger = true;
const proxyManager = new ProxyManager({ db });
const browser = new RunwayBrowser({ config, db, proxyManager, logger: console });
const runway = new RunwayClient({ db, proxyManager });
const worker = new TaskWorker({ db, runway, config, logger: console });
const app = await buildApp({ config, db, browser, worker, proxyManager, runway, logger });

await browser.start();
await app.listen({ host: config.host, port: config.port });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
