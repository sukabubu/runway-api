import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RunwayClient, parseRunwayTaskResponse } from '../src/runway/client.js';

describe('RunwayClient', () => {
  it('parses task responses', () => {
    expect(parseRunwayTaskResponse({
      task: {
        id: 'runway-task',
        status: 'RUNNING',
        progressRatio: 0.42,
        artifacts: [{ url: 'https://video', previewUrls: ['https://thumb'] }]
      }
    })).toMatchObject({
      taskId: 'runway-task',
      status: 'generating',
      progress: 42,
      videoUrl: 'https://video',
      thumbnailUrl: 'https://thumb'
    });
  });

  it('invalidates credentials on auth failure', async () => {
    const db = {
      getCredentials: () => ({ jwt: 'jwt' }),
      getRuntimeConfig: () => ({ requestTimeoutMs: 120000, maxRetries: 0, retryBackoffMs: [] }),
      invalidateCredentials: vi.fn()
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'no' }), { status: 403 }));
    const client = new RunwayClient({ db, fetchImpl });
    await expect(client.call('GET', '/v1/tasks/task')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(db.invalidateCredentials).toHaveBeenCalled();
  });

  it('sends video references separately for Seedance 2', async () => {
    const db = {
      getCredentials: () => ({ jwt: 'jwt', team_id: 1, asset_group_id: 'asset-group' }),
      getRuntimeConfig: () => ({ requestTimeoutMs: 120000, maxRetries: 0, retryBackoffMs: [] })
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ task: { id: 'runway-task', status: 'PENDING' } })));
    const client = new RunwayClient({ db, fetchImpl });
    await client.submitTask({
      prompt: 'continue the shot',
      model: 'seedance_2',
      duration: 5,
      resolution: '720p',
      aspectRatio: '16:9',
      generateAudio: true,
      exploreMode: true
    }, [{
      runwayAssetId: 'video-asset',
      runwayUrl: 'https://example.com/reference.mp4',
      mimeType: 'video/mp4'
    }]);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.options.referenceImages).toBeUndefined();
    expect(body.options.referenceVideos).toEqual([{
      assetId: 'video-asset',
      url: 'https://example.com/reference.mp4',
      previewUrl: null
    }]);
  });

  it('calls Runway task cancel endpoint', async () => {
    const db = {
      getCredentials: () => ({ jwt: 'jwt' }),
      getRuntimeConfig: () => ({ requestTimeoutMs: 120000, maxRetries: 0, retryBackoffMs: [] })
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ task: { id: 'runway-task', status: 'CANCELED' } })));
    const client = new RunwayClient({ db, fetchImpl });
    await expect(client.cancelTask('runway-task')).resolves.toMatchObject({ ok: true });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.runwayml.com/v1/tasks/runway-task/cancel');
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
  });

  it('checks whether Runway can start another task', async () => {
    const db = {
      getCredentials: () => ({ jwt: 'jwt', team_id: 1 }),
      getRuntimeConfig: () => ({ requestTimeoutMs: 120000, maxRetries: 3, retryBackoffMs: [] })
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ canStart: false, reason: 'Too many tasks are running or pending at the moment.' })));
    const client = new RunwayClient({ db, fetchImpl });
    await expect(client.canStartTask({ model: 'seedance_2' })).resolves.toMatchObject({
      ok: false,
      reason: 'Too many tasks are running or pending at the moment.'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.runwayml.com/v1/tasks/can_start');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      feature: 'gen4.5',
      taskType: 'seedance_2',
      asTeamId: 1
    });
  });

  it('allows submission when can_start is unavailable', async () => {
    const db = {
      getCredentials: () => ({ jwt: 'jwt' }),
      getRuntimeConfig: () => ({ requestTimeoutMs: 120000, maxRetries: 0, retryBackoffMs: [] }),
      logRequest: vi.fn()
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    const client = new RunwayClient({ db, fetchImpl });
    await expect(client.canStartTask({ model: 'gen4' })).resolves.toMatchObject({
      ok: true,
      skipped: true
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(db.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'runway:can_start',
      status: 'skipped'
    }));
  });

  it('sends content-length for presigned S3 uploads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-upload-test-'));
    const filePath = path.join(dir, 'image.png');
    fs.writeFileSync(filePath, Buffer.from('image-bytes'));
    const uploadResponses = [
      { uploadUrls: ['https://s3.example.com/upload-main'], uploadHeaders: { 'Content-Type': 'image/png' }, id: 'upload-main' },
      { ok: true },
      { uploadUrls: ['https://s3.example.com/upload-preview'], uploadHeaders: { 'Content-Type': 'image/png' }, id: 'upload-preview' },
      { ok: true },
      { dataset: { id: 'asset-1', url: 'https://cdn.example.com/image.png', previewUrls: ['https://cdn.example.com/preview.png'] } }
    ];
    const db = {
      getCredentials: () => ({ jwt: 'jwt', team_id: 1 }),
      getRuntimeConfig: () => ({ requestTimeoutMs: 120000, maxRetries: 0, retryBackoffMs: [] }),
      logRequest: vi.fn()
    };
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).startsWith('https://s3.example.com/')) {
        return new Response('', { status: 200, headers: { etag: '"etag-1"' } });
      }
      const next = uploadResponses.shift();
      return new Response(JSON.stringify(next));
    });
    const client = new RunwayClient({ db, fetchImpl });

    await client.uploadAsset({
      filename: 'image.png',
      localPath: filePath,
      mimeType: 'image/png'
    });

    const putCalls = fetchImpl.mock.calls.filter(([url]) => String(url).startsWith('https://s3.example.com/'));
    expect(putCalls).toHaveLength(2);
    expect(putCalls[0][1].headers).toMatchObject({
      'Content-Type': 'image/png',
      'Content-Length': '11'
    });
    expect(putCalls[1][1].headers).toMatchObject({
      'Content-Type': 'image/png',
      'Content-Length': '11'
    });
  });

  it('tries direct S3 upload before falling back to proxy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-api-upload-fallback-test-'));
    const filePath = path.join(dir, 'image.png');
    fs.writeFileSync(filePath, Buffer.from('image-bytes'));
    const uploadResponses = [
      { uploadUrls: ['https://s3.example.com/upload-main'], uploadHeaders: { 'Content-Type': 'image/png' }, id: 'upload-main' },
      { ok: true },
      { uploadUrls: ['https://s3.example.com/upload-preview'], uploadHeaders: { 'Content-Type': 'image/png' }, id: 'upload-preview' },
      { ok: true },
      { dataset: { id: 'asset-1', url: 'https://cdn.example.com/image.png', previewUrls: ['https://cdn.example.com/preview.png'] } }
    ];
    const db = {
      getCredentials: () => ({ jwt: 'jwt', team_id: 1 }),
      getRuntimeConfig: () => ({ requestTimeoutMs: 120000, maxRetries: 1, retryBackoffMs: [1] }),
      logRequest: vi.fn()
    };
    const proxy = { id: 'proxy-1', url: 'http://proxy.local:8080' };
    const agent = { proxyAgent: true };
    let useProxyForNextResolve = false;
    const proxyManager = {
      resolveForAccount: vi.fn(() => {
        if (!useProxyForNextResolve) return { proxy: null };
        useProxyForNextResolve = false;
        return { proxy };
      }),
      createAgent: vi.fn(() => agent)
    };
    const fetchImpl = vi.fn(async (url) => {
      if (String(url) === 'https://s3.example.com/upload-main') {
        useProxyForNextResolve = true;
        throw new Error('The operation was aborted');
      }
      if (String(url).startsWith('https://s3.example.com/')) {
        return new Response('', { status: 200, headers: { etag: '"etag-direct"' } });
      }
      const next = uploadResponses.shift();
      return new Response(JSON.stringify(next));
    });
    const nodeFetchWithAgentImpl = vi.fn(async () => new Response('', { status: 200, headers: { etag: '"etag-proxy"' } }));
    const client = new RunwayClient({ db, proxyManager, fetchImpl, nodeFetchWithAgentImpl });

    await client.uploadAsset({
      filename: 'image.png',
      localPath: filePath,
      mimeType: 'image/png'
    });

    const directPutCalls = fetchImpl.mock.calls.filter(([url]) => String(url).startsWith('https://s3.example.com/'));
    expect(directPutCalls.map(([url]) => url)).toEqual([
      'https://s3.example.com/upload-main',
      'https://s3.example.com/upload-preview'
    ]);
    expect(proxyManager.createAgent).toHaveBeenCalledTimes(1);
    expect(proxyManager.createAgent).toHaveBeenCalledWith(proxy);
    expect(nodeFetchWithAgentImpl).toHaveBeenCalledTimes(1);
    expect(nodeFetchWithAgentImpl.mock.calls[0][0]).toBe('https://s3.example.com/upload-main');
    expect(nodeFetchWithAgentImpl.mock.calls[0][1]).toMatchObject({
      method: 'PUT',
      agent,
      timeoutMs: 30000
    });
    expect(db.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      operation: 's3:put',
      status: 'failed',
      proxyId: undefined,
      message: 'The operation was aborted'
    }));
    expect(db.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      operation: 's3:put',
      status: 'success',
      proxyId: 'proxy-1'
    }));
  });
});
