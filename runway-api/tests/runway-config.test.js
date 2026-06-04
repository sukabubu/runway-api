import { describe, expect, it } from 'vitest';
import { findRunwayModel, mapRunwayStatus, normalizeTaskInput } from '../src/runway/config.js';

describe('Runway config', () => {
  it('maps Runway statuses', () => {
    expect(mapRunwayStatus('PENDING')).toBe('queuing');
    expect(mapRunwayStatus('RUNNING')).toBe('generating');
    expect(mapRunwayStatus('SUCCEEDED')).toBe('completed');
    expect(mapRunwayStatus('THROTTLED_FOR_TOO_LONG')).toBe('failed');
    expect(mapRunwayStatus('CANCELED')).toBe('cancelled');
  });

  it('normalizes task defaults and booleans', () => {
    expect(normalizeTaskInput({ prompt: 'hello', generateAudio: 'false' })).toMatchObject({
      prompt: 'hello',
      model: 'seedance_2',
      duration: 5,
      resolution: '480p',
      aspectRatio: '16:9',
      generateAudio: false,
      exploreMode: true
    });
  });

  it('accepts Seedance 2 integer durations from 5 to 15 seconds', () => {
    expect(normalizeTaskInput({ prompt: 'hello', duration: '6' }).duration).toBe(6);
    expect(normalizeTaskInput({ prompt: 'hello', seconds: '10' }).duration).toBe(10);
    expect(normalizeTaskInput({ prompt: 'hello', duration: '14' }).duration).toBe(14);
    expect(normalizeTaskInput({ prompt: 'hello', duration: '4' }).duration).toBe(5);
  });

  it('accepts OpenAI-style size values', () => {
    expect(normalizeTaskInput({ prompt: 'hello', size: '1280x720' })).toMatchObject({
      resolution: '720p',
      aspectRatio: '16:9'
    });
    expect(normalizeTaskInput({ prompt: 'hello', size: '720x1280' })).toMatchObject({
      resolution: '720p',
      aspectRatio: '9:16'
    });
    expect(normalizeTaskInput({ prompt: 'hello', size: '1024x1024' })).toMatchObject({
      resolution: '1080p',
      aspectRatio: '1:1'
    });
  });

  it('rejects missing prompt', () => {
    expect(() => normalizeTaskInput({ prompt: ' ' })).toThrow('prompt is required');
  });

  it('rejects prompts longer than 3500 characters', () => {
    expect(() => normalizeTaskInput({ prompt: 'x'.repeat(3501) })).toThrow('Too big: expected string to have <=3500 characters');
    expect(normalizeTaskInput({ prompt: 'x'.repeat(3500) }).prompt).toHaveLength(3500);
  });

  it('normalizes GPT Image 2 inputs', () => {
    expect(findRunwayModel('gpt_image_2')).toMatchObject({
      kind: 'image',
      taskType: 'gpt_image_2',
      maxReferenceImages: 16,
      maxReferenceVideos: 0,
      defaultAspectRatio: '16:9',
      allowedNumImages: [1, 4]
    });
    expect(normalizeTaskInput({
      model: 'gpt_image_2',
      prompt: 'draw an apple',
      size: '1024x1024',
      quality: 'medium',
      n: 4
    })).toMatchObject({
      kind: 'image',
      model: 'gpt_image_2',
      aspectRatio: '1:1',
      resolution: '1K',
      quality: 'medium',
      numImages: 4,
      generateAudio: false
    });
    expect(() => normalizeTaskInput({ model: 'gpt_image_2', prompt: 'x', n: 2 })).toThrow('n must be one of: 1, 4');
  });
});
