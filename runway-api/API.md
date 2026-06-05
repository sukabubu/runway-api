# 视频生成 API 调用文档

本文档仅面向业务调用方，说明如何使用 OpenAI 兼容接口创建、查询和下载视频。

## 基础信息

默认请求地址：

```text
http://127.0.0.1:8790
```

所有 `/v1` 接口都使用 Bearer Token 鉴权：

```http
Authorization: Bearer <API_KEY>
```

除 `GET /v1/models` 外，其它接口都需要鉴权。

## 模型列表

### `GET /v1/models`

```bash
curl http://127.0.0.1:8790/v1/models
```

响应示例：

```json
{
  "object": "list",
  "data": [
    {
      "id": "seedance_2",
      "object": "model",
      "created": 0,
      "owned_by": "video-api",
      "name": "Seedance 2.0"
    },
    {
      "id": "gpt_image_2",
      "object": "model",
      "created": 0,
      "owned_by": "video-api",
      "name": "GPT Image 2",
      "taskType": "image"
    }
  ]
}
```

## 创建视频

### `POST /v1/videos`

支持 `application/json` 和 `multipart/form-data` 两种请求格式。推荐优先使用 URL 传参考素材。

### JSON 请求

```bash
curl -X POST http://127.0.0.1:8790/v1/videos \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance_2",
    "prompt": "A cinematic product video with soft studio lighting and a slow camera push-in.",
    "seconds": "5",
    "size": "1280x720",
    "media_urls": [
      "https://example.com/reference-image.jpg",
      "https://example.com/reference-video.mp4"
    ]
  }'
```

### Multipart 请求

```bash
curl -X POST http://127.0.0.1:8790/v1/videos \
  -H "Authorization: Bearer <API_KEY>" \
  -F "model=seedance_2" \
  -F "prompt=A cinematic product video with soft studio lighting." \
  -F "seconds=5" \
  -F "size=1280x720" \
  -F "media_urls=https://example.com/reference-image.jpg" \
  -F "media[]=@/absolute/path/to/reference-video.mp4"
```

### 请求字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 是 | 视频提示词，也兼容 `input`；最大 `3500` 个字符 |
| `model` | string | 否 | 模型 ID，不传使用默认模型 |
| `seconds` | string/number | 否 | 视频秒数，也兼容 `duration` |
| `size` | string | 否 | 视频尺寸，例如 `1280x720`、`720x1280`、`1024x1024` |
| `media_urls` | string/string[] | 否 | 参考素材 URL，也兼容 `mediaUrls`、`reference_urls`、`referenceUrls` |
| `references` | array | 否 | 带名称的参考素材列表 |
| `media[]` | file[] | 否 | multipart 上传的本地参考素材 |

`media_urls` 可以传数组，也可以传逗号分隔或换行分隔字符串。

`prompt` / `input` 超过 `3500` 个字符会返回请求错误：

```json
{
  "error": {
    "message": "Too big: expected string to have <=3500 characters",
    "type": "invalid_request_error",
    "param": null,
    "code": "request_failed"
  }
}
```

### 命名参考素材

未命名的参考素材会按上传顺序自动命名：

| 素材类型 | 自动名称 |
| --- | --- |
| 图片 | `IMG_1`、`IMG_2`、`IMG_3` |
| 视频 | `VID_1`、`VID_2`、`VID_3` |

因此可以在提示词里引用：

```json
{
  "prompt": "Use @IMG_1 as the subject appearance and @VID_1 as the motion reference.",
  "media_urls": [
    "https://example.com/subject.jpg",
    "https://example.com/motion.mp4"
  ]
}
```

也可以使用 `references` 显式命名：

```json
{
  "prompt": "Use @subject as the character and @motion as the movement reference.",
  "references": [
    { "name": "subject", "url": "https://example.com/subject.jpg" },
    { "name": "motion", "url": "https://example.com/motion.mp4" }
  ]
}
```

### 成功响应

创建成功后会返回任务对象，后续通过查询接口获取结果。

```json
{
  "id": "b3c9e2c4-4d4d-4a97-9d79-000000000000",
  "object": "video",
  "created": 1779190000,
  "created_at": 1779190000,
  "model": "seedance_2",
  "prompt": "A cinematic product video with soft studio lighting.",
  "seconds": "5",
  "size": "1280x720",
  "status": "queued",
  "progress": null,
  "video_url": null,
  "thumbnail_url": null,
  "error": null,
  "metadata": {
    "prompt": "A cinematic product video with soft studio lighting.",
    "duration": 5,
    "resolution": "720p",
    "aspect_ratio": "16:9"
  }
}
```

## 查询视频

### `GET /v1/videos/:id`

```bash
curl -H "Authorization: Bearer <API_KEY>" \
  http://127.0.0.1:8790/v1/videos/b3c9e2c4-4d4d-4a97-9d79-000000000000
```

完成响应示例：

```json
{
  "id": "b3c9e2c4-4d4d-4a97-9d79-000000000000",
  "object": "video",
  "created": 1779190000,
  "created_at": 1779190000,
  "model": "seedance_2",
  "prompt": "A cinematic product video with soft studio lighting.",
  "seconds": "5",
  "size": "1280x720",
  "status": "completed",
  "progress": 100,
  "video_url": "https://api.example.com/v1/videos/b3c9e2c4-4d4d-4a97-9d79-000000000000/content?expires=...",
  "thumbnail_url": "https://api.example.com/v1/videos/b3c9e2c4-4d4d-4a97-9d79-000000000000/thumbnail?expires=...",
  "error": null,
  "metadata": {
    "prompt": "A cinematic product video with soft studio lighting.",
    "duration": 5,
    "resolution": "720p",
    "aspect_ratio": "16:9"
  }
}
```

### 状态值

| status | 说明 |
| --- | --- |
| `queued` | 等待处理 |
| `in_progress` | 正在生成 |
| `completed` | 已完成 |
| `failed` | 失败 |
| `cancelled` | 已取消 |

## 下载视频

任务完成后，直接使用查询结果里的 `video_url` 下载视频，使用 `thumbnail_url` 下载封面。

```bash
curl -L -o output.mp4 \
  "https://api.example.com/v1/videos/b3c9e2c4-4d4d-4a97-9d79-000000000000/content?expires=..."
```

如果下载链接失效，重新调用 `GET /v1/videos/:id` 获取新的链接。

## 创建图片

### `POST /v1/images/generations`

文生图入口。参考图请使用 `POST /v1/images/edits`。

```bash
curl -X POST http://127.0.0.1:8790/v1/images/generations \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "A red apple on a clean white background.",
    "size": "1024x1024",
    "quality": "high",
    "n": 1
  }'
```

请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 是 | 图片提示词，也兼容 `input`；最大 `3500` 个字符 |
| `model` | string | 否 | 默认 `gpt-image-2`；兼容 `gpt-image-1`、`gpt-image-1.5`、`gpt-image-1-mini`、`gpt_image_2`，内部映射到 Runway GPT Image 2 |
| `size` | string | 否 | 图片尺寸，例如 `1024x1024`、`1280x720`；默认按 `16:9`、`1K` 生成 |
| `quality` | string | 否 | `low`、`medium`、`high` |
| `n` | number | 否 | 图片数量，只支持 `1` 或 `4` |

创建成功会返回异步任务对象，不会阻塞等待图片完成：

```json
{
  "id": "b3c9e2c4-4d4d-4a97-9d79-000000000000",
  "object": "image.generation",
  "created": 1779190000,
  "created_at": 1779190000,
  "model": "gpt_image_2",
  "prompt": "A red apple on a clean white background.",
  "status": "queued",
  "progress": null,
  "data": [],
  "error": null
}
```

### `POST /v1/images/edits`

带参考图的图片编辑入口。支持 JSON URL 参考图和 multipart 本地图片；不支持视频参考。

```bash
curl -X POST http://127.0.0.1:8790/v1/images/edits \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "Keep the same product, place it on a marble table.",
    "size": "1024x1024",
    "quality": "high",
    "image_urls": ["https://example.com/reference-image.jpg"]
  }'
```

Multipart 示例：

```bash
curl -X POST http://127.0.0.1:8790/v1/images/edits \
  -H "Authorization: Bearer <API_KEY>" \
  -F "model=gpt-image-2" \
  -F "prompt=Keep the same character, change the background." \
  -F "size=1024x1024" \
  -F "image[]=@/absolute/path/to/reference.png"
```

参考图字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `image_urls` | string/string[] | 否 | 图片参考 URL，也兼容 `media_urls`、`reference_urls` |
| `references` | array | 否 | 带名称的图片参考素材 |
| `image[]` / `media[]` | file[] | 否 | multipart 上传的本地图片参考素材 |

## 查询图片

### `GET /v1/images/:id`

```bash
curl -H "Authorization: Bearer <API_KEY>" \
  http://127.0.0.1:8790/v1/images/b3c9e2c4-4d4d-4a97-9d79-000000000000
```

完成响应示例：

```json
{
  "id": "b3c9e2c4-4d4d-4a97-9d79-000000000000",
  "object": "image.generation",
  "created": 1779190000,
  "created_at": 1779190000,
  "model": "gpt_image_2",
  "prompt": "A red apple on a clean white background.",
  "status": "completed",
  "progress": 100,
  "data": [
    {
      "url": "https://api.example.com/v1/images/b3c9e2c4-4d4d-4a97-9d79-000000000000/content?expires=..."
    }
  ],
  "error": null
}
```

图片下载链接失效时，重新调用 `GET /v1/images/:id` 获取新的链接。

## 查询列表

### `GET /v1/videos`

```bash
curl -H "Authorization: Bearer <API_KEY>" \
  "http://127.0.0.1:8790/v1/videos?status=completed&limit=20"
```

查询参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | 可选，按状态筛选 |
| `limit` | number | 可选，返回数量 |
| `offset` | number | 可选，分页偏移 |

响应示例：

```json
{
  "object": "list",
  "data": [
    {
      "id": "b3c9e2c4-4d4d-4a97-9d79-000000000000",
      "object": "video",
      "status": "completed",
      "video_url": "https://api.example.com/v1/videos/b3c9e2c4-4d4d-4a97-9d79-000000000000/content?expires=...",
      "thumbnail_url": "https://api.example.com/v1/videos/b3c9e2c4-4d4d-4a97-9d79-000000000000/thumbnail?expires=...",
      "error": null
    }
  ]
}
```

## 取消任务

### `POST /v1/videos/:id/cancel`

```bash
curl -X POST \
  -H "Authorization: Bearer <API_KEY>" \
  http://127.0.0.1:8790/v1/videos/b3c9e2c4-4d4d-4a97-9d79-000000000000/cancel
```

响应会返回最新任务对象。

## 重试任务

### `POST /v1/videos/:id/retry`

```bash
curl -X POST \
  -H "Authorization: Bearer <API_KEY>" \
  http://127.0.0.1:8790/v1/videos/b3c9e2c4-4d4d-4a97-9d79-000000000000/retry
```

仅失败任务可重试。响应会返回新的任务对象。

## 错误格式

接口错误和任务失败都使用 OpenAI 风格错误对象。

### 请求错误示例

```json
{
  "error": {
    "message": "未登录或 API Key 不正确。",
    "type": "invalid_request_error",
    "param": null,
    "code": "unauthorized"
  }
}
```

### 任务失败示例

```json
{
  "id": "b3c9e2c4-4d4d-4a97-9d79-000000000000",
  "object": "video",
  "status": "failed",
  "error": {
    "message": "The prompt describes content that is not allowed.",
    "code": "content_policy_violation",
    "type": "video_generation_error",
    "param": null,
    "reason": "The prompt describes content that is not allowed."
  }
}
```

任务失败时，`error.message` 和 `error.reason` 会优先返回失败详情；不会把失败原因改写成概括性的中文解释。

下游建议：

- 展示给用户：`error.message`
- 程序分类处理：`error.code`
- 查看详细原因：`error.reason`

常见 `error.code`：

| code | 说明 |
| --- | --- |
| `content_policy_violation` | 内容审核未通过 |
| `timeout` | 任务超时 |
| `authentication_failed` | 服务暂时不可用或鉴权失败 |
| `generation_failed` | 生成失败 |
| `cancelled` | 任务已取消 |

## JavaScript 示例

```js
const baseUrl = 'http://127.0.0.1:8790';
const apiKey = '<API_KEY>';

const createResp = await fetch(`${baseUrl}/v1/videos`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'seedance_2',
    prompt: 'A cinematic product video with soft studio lighting.',
    seconds: '5',
    size: '1280x720',
    media_urls: ['https://example.com/reference.jpg']
  })
});

const task = await createResp.json();

while (true) {
  const resp = await fetch(`${baseUrl}/v1/videos/${task.id}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const current = await resp.json();

  if (current.status === 'completed') {
    console.log(current.video_url);
    break;
  }

  if (current.status === 'failed') {
    throw new Error(current.error?.message || 'Video generation failed');
  }

  await waitBeforeNextQuery();
}
```

## Python 示例

```python
import requests

base_url = "http://127.0.0.1:8790"
api_key = "<API_KEY>"
headers = {"Authorization": f"Bearer {api_key}"}

resp = requests.post(
    f"{base_url}/v1/videos",
    headers={**headers, "Content-Type": "application/json"},
    json={
        "model": "seedance_2",
        "prompt": "A cinematic product video with soft studio lighting.",
        "seconds": "5",
        "size": "1280x720",
        "media_urls": ["https://example.com/reference.jpg"],
    },
)

task = resp.json()

while True:
    current = requests.get(f"{base_url}/v1/videos/{task['id']}", headers=headers).json()
    if current["status"] == "completed":
        print(current["video_url"])
        break
    if current["status"] == "failed":
        raise RuntimeError(current.get("error", {}).get("message", "Video generation failed"))
    wait_before_next_query()
```
