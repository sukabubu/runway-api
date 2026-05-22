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
});
