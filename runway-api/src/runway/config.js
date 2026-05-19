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
  canStart: '/v1/tasks/can_start',
  estimateCost: '/v1/billing/estimate_feature_cost_credits'
};

export const RUNWAY_MODELS = [
  {
    id: 'seedance_2',
    label: 'Seedance 2.0',
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
  return RUNWAY_MODELS.find((model) => model.id === id) || RUNWAY_MODELS[0];
}

export function mapRunwayStatus(rawStatus) {
  return RUNWAY_STATUS_MAP[String(rawStatus || '').toUpperCase()] || 'unknown';
}

export function normalizeTaskInput(input = {}) {
  const model = findRunwayModel(input.model || DEFAULT_TASK_CONFIG.model);
  const duration = Number(input.duration ?? DEFAULT_TASK_CONFIG.duration);
  const config = {
    prompt: String(input.prompt || '').trim(),
    model: model.id,
    duration: model.durations.includes(duration) ? duration : model.durations[0],
    resolution: model.resolutions.includes(input.resolution) ? input.resolution : model.resolutions[0],
    aspectRatio: model.aspectRatios.includes(input.aspectRatio) ? input.aspectRatio : model.aspectRatios[0],
    generateAudio: input.generateAudio == null ? DEFAULT_TASK_CONFIG.generateAudio : toBoolean(input.generateAudio),
    exploreMode: input.exploreMode == null ? DEFAULT_TASK_CONFIG.exploreMode : toBoolean(input.exploreMode)
  };
  if (!config.prompt) {
    const err = new Error('prompt is required');
    err.statusCode = 400;
    throw err;
  }
  if (!model.supportsAudio) config.generateAudio = false;
  if (!model.supportsExploreMode) config.exploreMode = false;
  return config;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
