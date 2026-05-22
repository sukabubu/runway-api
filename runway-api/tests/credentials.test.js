import { describe, expect, it } from 'vitest';
import {
  extractCredentialsFromJson,
  extractCredentialsFromRequest,
  extractCredentialsFromResponse
} from '../src/runway/credentials.js';

describe('credential extraction', () => {
  it('extracts auth, team, and fingerprint headers from requests', () => {
    const patch = extractCredentialsFromRequest({
      url: 'https://api.runwayml.com/v1/tasks?asTeamId=123',
      method: 'POST',
      headers: {
        authorization: 'Bearer jwt-token',
        cookie: 'session=abc; other=1',
        'x-runway-client-id': 'client-1',
        'x-runway-source-application-version': 'version-1'
      },
      postData: JSON.stringify({ options: { assetGroupId: 'asset-group' } })
    });
    expect(patch).toEqual({
      jwt: 'jwt-token',
      cookieHeader: 'session=abc; other=1',
      teamId: 123,
      clientId: 'client-1',
      sourceApplicationVersion: 'version-1',
      assetGroupId: 'asset-group'
    });
  });

  it('extracts ids from json payloads and by_name responses', () => {
    expect(extractCredentialsFromJson(JSON.stringify({ asTeamId: 44, assetGroupId: 'ag' }))).toEqual({
      teamId: 44,
      assetGroupId: 'ag'
    });
    expect(extractCredentialsFromResponse({
      url: 'https://api.runwayml.com/v1/asset_groups/by_name',
      text: JSON.stringify({ assetGroup: { id: 'from-response' } })
    })).toEqual({ assetGroupId: 'from-response' });
    expect(extractCredentialsFromResponse({
      url: 'https://api.runwayml.com/v1/some_bootstrap_payload',
      text: JSON.stringify({
        data: {
          workspaceId: 66,
          currentProject: { defaultAssetGroupId: 'nested-asset-group' }
        }
      })
    })).toEqual({ assetGroupId: 'nested-asset-group', teamId: 66 });
  });
});
