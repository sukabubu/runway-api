export const RUNWAY_HOST = 'https://api.runwayml.com';

export const RUNWAY_ENDPOINTS = {
  profile: '/v1/profile',
  profileFeatures: '/v1/profile/features',
  sessions: '/v1/sessions',
  uploads: '/v1/uploads',
  uploadComplete: (uploadId) => `/v1/uploads/${uploadId}/complete`,
  datasets: '/v1/datasets',
  tasks: '/v1/tasks',
  task: (taskId) => `/v1/tasks/${taskId}`,
  taskCancel: (taskId) => `/v1/tasks/${taskId}/cancel`,
  canStart: '/v1/tasks/can_start',
  estimateCost: '/v1/billing/estimate_feature_cost_credits'
};

export const RUNWAY_MODELS = [
  {
    id: 'seedance_2',
    label: 'Seedance 2.0',
    kind: 'video',
    taskType: 'seedance_2',
    estimateFeature: 'gen4',
    canStartFeature: 'gen4.5',
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    resolutions: ['480p', '720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    supportsAudio: true,
    supportsExploreMode: true,
    supportsReferenceImages: true,
    supportsReferenceVideos: true,
    maxReferenceImages: 9,
    maxReferenceVideos: 3
  },
  {
    id: 'gen4',
    label: 'Gen-4',
    kind: 'video',
    taskType: 'gen4',
    estimateFeature: 'gen4',
    canStartFeature: 'gen4',
    durations: [5, 10],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    supportsAudio: false,
    supportsExploreMode: true,
    supportsReferenceImages: true,
    supportsReferenceVideos: false,
    maxReferenceImages: 15,
    maxReferenceVideos: 0
  },
  {
    id: 'gpt_image_2',
    publicId: 'gpt-image-2',
    label: 'GPT Image 2',
    kind: 'image',
    taskType: 'gpt_image_2',
    aspectRatios: ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'],
    resolutions: ['1K', '2K', '4K'],
    qualities: ['low', 'medium', 'high'],
    supportsAudio: false,
    supportsExploreMode: true,
    supportsReferenceImages: true,
    supportsReferenceVideos: false,
    maxReferenceImages: 16,
    maxReferenceVideos: 0,
    defaultAspectRatio: '16:9',
    defaultResolution: '1K',
    defaultQuality: 'high',
    defaultNumImages: 1,
    allowedNumImages: [1, 4],
    maxNumImages: 4
  }
];

export const DEFAULT_TASK_CONFIG = {
  model: 'seedance_2',
  duration: 5,
  resolution: '480p',
  aspectRatio: '16:9',
  generateAudio: true,
  exploreMode: true
};

export const RUNWAY_STATUS_MAP = {
  PENDING: 'queuing',
  QUEUED: 'queuing',
  THROTTLED: 'queuing',
  RUNNING: 'generating',
  PROCESSING: 'generating',
  SUCCEEDED: 'completed',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'cancelled',
  CANCELLED: 'cancelled',
  THROTTLED_FOR_TOO_LONG: 'failed'
};

export function findRunwayModel(id) {
  const normalized = normalizeModelId(id);
  return RUNWAY_MODELS.find((model) => model.id === normalized || model.publicId === id) || RUNWAY_MODELS[0];
}

export function normalizeModelId(id) {
  const value = String(id || '').trim();
  if (['gpt-image-2', 'gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini', 'gpt_image_2'].includes(value)) return 'gpt_image_2';
  return value;
}

export function mapRunwayStatus(rawStatus) {
  return RUNWAY_STATUS_MAP[String(rawStatus || '').toUpperCase()] || 'unknown';
}

export function normalizeTaskInput(input = {}) {
  const model = findRunwayModel(input.model || DEFAULT_TASK_CONFIG.model);
  const openAiSize = parseOpenAiSize(input.size);
  const duration = Number(input.duration ?? input.seconds ?? DEFAULT_TASK_CONFIG.duration);
  const prompt = String(input.prompt || '').trim();
  if (prompt.length > 3500) {
    const err = new Error('Too big: expected string to have <=3500 characters');
    err.statusCode = 400;
    throw err;
  }
  const config = {
    kind: model.kind || 'video',
    prompt,
    model: model.id,
    duration: model.durations?.includes(duration) ? duration : (model.durations?.[0] ?? 1),
    resolution: model.resolutions.includes(input.resolution ?? openAiSize?.resolution) ? (input.resolution ?? openAiSize.resolution) : model.resolutions[0],
    aspectRatio: model.aspectRatios.includes(input.aspectRatio ?? input.aspect_ratio ?? openAiSize?.aspectRatio) ? (input.aspectRatio ?? input.aspect_ratio ?? openAiSize.aspectRatio) : model.aspectRatios[0],
    generateAudio: input.generateAudio == null ? DEFAULT_TASK_CONFIG.generateAudio : toBoolean(input.generateAudio),
    exploreMode: input.exploreMode == null ? DEFAULT_TASK_CONFIG.exploreMode : toBoolean(input.exploreMode)
  };
  if (!config.prompt) {
    const err = new Error('prompt is required');
    err.statusCode = 400;
    throw err;
  }
  if (model.kind === 'image') {
    const imageSize = parseOpenAiImageSize(input.size);
    const requestedAspectRatio = input.aspectRatio ?? input.aspect_ratio ?? imageSize?.aspectRatio;
    const requestedResolution = input.resolution ?? imageSize?.resolution;
    const requestedQuality = input.quality;
    const requestedNumImages = Number(input.n ?? input.numImages ?? input.num_images ?? model.defaultNumImages ?? 1);
    const allowedNumImages = model.allowedNumImages || Array.from({ length: model.maxNumImages || 4 }, (_, index) => index + 1);
    if (!Number.isInteger(requestedNumImages) || !allowedNumImages.includes(requestedNumImages)) {
      const err = new Error(`n must be one of: ${allowedNumImages.join(', ')}`);
      err.statusCode = 400;
      throw err;
    }
    config.duration = 1;
    config.resolution = model.resolutions.includes(requestedResolution) ? requestedResolution : model.defaultResolution;
    config.aspectRatio = model.aspectRatios.includes(requestedAspectRatio) ? requestedAspectRatio : model.defaultAspectRatio;
    config.generateAudio = false;
    config.exploreMode = input.exploreMode == null ? true : toBoolean(input.exploreMode);
    config.quality = model.qualities.includes(requestedQuality) ? requestedQuality : model.defaultQuality;
    config.background = ['auto', 'transparent', 'opaque'].includes(input.background) ? input.background : 'auto';
    config.numImages = requestedNumImages;
  }
  if (!model.supportsAudio) config.generateAudio = false;
  if (!model.supportsExploreMode) config.exploreMode = false;
  return config;
}

function parseOpenAiSize(value) {
  if (!value) return null;
  const match = String(value).trim().toLowerCase().match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const resolution = nearestResolution(shortSide);
  return {
    resolution,
    aspectRatio: nearestAspectRatio(longSide / shortSide, width >= height)
  };
}

function parseOpenAiImageSize(value) {
  if (!value) return null;
  const match = String(value).trim().toLowerCase().match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  const shortSide = Math.min(width, height);
  return {
    resolution: nearestImageResolution(shortSide),
    aspectRatio: nearestImageAspectRatio(width, height)
  };
}

function nearestImageResolution(shortSide) {
  if (shortSide >= 3000) return '4K';
  if (shortSide >= 1500) return '2K';
  return '1K';
}

function nearestImageAspectRatio(width, height) {
  const ratio = width / height;
  const candidates = [
    ['21:9', 21 / 9],
    ['16:9', 16 / 9],
    ['3:2', 3 / 2],
    ['4:3', 4 / 3],
    ['5:4', 5 / 4],
    ['1:1', 1],
    ['4:5', 4 / 5],
    ['3:4', 3 / 4],
    ['2:3', 2 / 3],
    ['9:16', 9 / 16]
  ];
  return candidates.reduce((best, current) => (
    Math.abs(current[1] - ratio) < Math.abs(best[1] - ratio) ? current : best
  ))[0];
}

function nearestResolution(value) {
  return [480, 720, 1080].reduce((best, current) => (
    Math.abs(current - value) < Math.abs(best - value) ? current : best
  ), 480) + 'p';
}

function nearestAspectRatio(ratio, landscape) {
  const candidates = landscape
    ? [
        ['16:9', 16 / 9],
        ['4:3', 4 / 3],
        ['1:1', 1]
      ]
    : [
        ['9:16', 16 / 9],
        ['3:4', 4 / 3],
        ['1:1', 1]
      ];
  return candidates.reduce((best, current) => (
    Math.abs(current[1] - ratio) < Math.abs(best[1] - ratio) ? current : best
  ))[0];
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
