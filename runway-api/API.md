# 视频生成 API 调用文档

本文档只说明外部业务方如何调用本服务生成视频。默认服务地址：

```text
http://127.0.0.1:8790
```

## 鉴权

视频调用接口需要业务 API Key：

```http
Authorization: Bearer <API_KEY>
```

默认值是：

```text
change-me
```

如果你在后台“系统配置”里改过 API Key，以后台配置为准。

## 1. OpenAI 兼容接口

外部业务方优先使用 `/v1/...` 接口，统一使用：

```http
Authorization: Bearer <API_KEY>
```

### `GET /v1/models`

```bash
curl http://127.0.0.1:8790/v1/models
```

返回 OpenAI 风格模型列表：

```json
{
  "object": "list",
  "data": [
    {
      "id": "seedance_2",
      "object": "model",
      "owned_by": "runway"
    }
  ]
}
```

### `POST /v1/videos`

文生视频可以直接传 JSON。参考素材优先传 URL，字段支持 `media_urls`、`mediaUrls`、`reference_urls`、`referenceUrls`，可以是数组、逗号分隔或换行分隔字符串。

如果你想按 Runway 网页习惯在提示词里写 `@素材名`，用 `references` 传带名字的素材：

```json
{
  "prompt": "使用 @主体 作为主体外观，使用 @动作 作为运动参考",
  "references": [
    { "name": "主体", "url": "https://example.com/subject.jpg" },
    { "name": "动作", "url": "https://example.com/motion.mp4" }
  ]
}
```

说明：服务端会用 `name` 作为素材文件名下载并上传，prompt 里的 `@主体` 会原样提交给 Runway；真正的引用对象仍然通过上传后的 `referenceImages` / `referenceVideos` 传给 Runway。

URL 素材要求：

- 只支持 `http` / `https`
- 只支持图片和视频，不支持音频
- 单个素材最大 `200MB`
- 服务会先下载到本地 `UPLOAD_DIR`，再上传到 Runway

```bash
curl -X POST http://127.0.0.1:8790/v1/videos \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance_2",
    "prompt": "a cinematic shot of waves at sunset, handheld camera, realistic lighting",
    "duration": 5,
    "resolution": "720p",
    "aspectRatio": "16:9",
    "generateAudio": true,
    "exploreMode": true,
    "media_urls": [
      "https://example.com/reference.jpg",
      "https://example.com/motion.mp4"
    ]
  }'
```

如果业务方必须上传本地文件，也可以使用 `multipart/form-data`；URL 和文件可以同时传：

```bash
curl -X POST http://127.0.0.1:8790/v1/videos \
  -H "Authorization: Bearer change-me" \
  -F "model=seedance_2" \
  -F "prompt=animate this reference with a slow dolly-in camera move" \
  -F "duration=5" \
  -F "resolution=720p" \
  -F "aspectRatio=16:9" \
  -F "media_urls=https://example.com/reference.jpg" \
  -F "media[]=@/absolute/path/to/reference.mp4"
```

成功响应：

```json
{
  "id": "b3c9e2c4-4d4d-4a97-9d79-000000000000",
  "object": "video",
  "created": 1779190000,
  "model": "seedance_2",
  "status": "queued",
  "runway_task_id": null,
  "video_url": null,
  "thumbnail_url": null,
  "error": null
}
```

### `GET /v1/videos/:id`

```bash
curl -H "Authorization: Bearer change-me" \
  http://127.0.0.1:8790/v1/videos/<task-id>
```

状态值会映射为 OpenAI 风格：

| status | 含义 |
| --- | --- |
| `queued` | 本地或 Runway 排队中 |
| `in_progress` | 提交中或生成中 |
| `completed` | 已完成，读取 `video_url` |
| `failed` | 失败，读取 `error.message` |
| `cancelled` | 已取消 |

### `GET /v1/videos`

```bash
curl -H "Authorization: Bearer change-me" \
  "http://127.0.0.1:8790/v1/videos?status=completed&limit=20"
```

### `POST /v1/videos/:id/retry`

```bash
curl -X POST -H "Authorization: Bearer change-me" \
  http://127.0.0.1:8790/v1/videos/<task-id>/retry
```

只能重试失败任务。

## 2. 可用模型

### `GET /models`

```bash
curl http://127.0.0.1:8790/models
```

当前主要模型：

| model | 说明 | 支持参考图 | 支持参考视频 | 生成音轨 |
| --- | --- | --- | --- | --- |
| `seedance_2` | Seedance 2.0 | 是 | 是 | 是 |
| `gen4` | Gen-4 | 是 | 否 | 否 |

`seedance_2` 支持：

- `duration`: `5` 到 `15` 的整数秒
- `resolution`: `480p`, `720p`, `1080p`
- `aspectRatio`: `16:9`, `9:16`, `1:1`, `4:3`, `3:4`
- 图片参考最多 `9` 张
- 视频参考最多 `3` 个
- 不支持上传音频。`generateAudio` 表示是否生成结果音轨，不是上传音频。

## 3. 旧版任务接口

以下 `/tasks` 接口仅为历史兼容保留，不建议新接入使用。新接入统一使用上面的 OpenAI 兼容 `/v1/videos`。

## 4. 创建视频任务

### `POST /tasks`

请求格式：`multipart/form-data`

字段：

| 字段 | 必填 | 示例 | 说明 |
| --- | --- | --- | --- |
| `prompt` | 是 | `a cinematic product shot` | 视频提示词 |
| `model` | 否 | `seedance_2` | 默认 `seedance_2` |
| `duration` | 否 | `5` | 秒数 |
| `resolution` | 否 | `720p` | 分辨率 |
| `aspectRatio` | 否 | `16:9` | 画面比例 |
| `generateAudio` | 否 | `true` | 是否生成结果音轨 |
| `exploreMode` | 否 | `true` | 是否开启探索模式 |
| `accountId` | 否 | `auto` | 指定 Runway 账号；不填或 `auto` 为自动负载 |
| `media[]` | 否 | `@ref.jpg`, `@ref.mp4` | 参考素材，支持图片和视频，不支持音频 |

### 文生视频

```bash
curl -X POST http://127.0.0.1:8790/tasks \
  -H "Authorization: Bearer change-me" \
  -F "prompt=a cinematic shot of waves at sunset, handheld camera, realistic lighting" \
  -F "model=seedance_2" \
  -F "duration=5" \
  -F "resolution=720p" \
  -F "aspectRatio=16:9" \
  -F "generateAudio=true" \
  -F "exploreMode=true"
```

### 图生视频

```bash
curl -X POST http://127.0.0.1:8790/tasks \
  -H "Authorization: Bearer change-me" \
  -F "prompt=animate this product shot with a slow dolly-in camera move" \
  -F "model=seedance_2" \
  -F "duration=5" \
  -F "resolution=720p" \
  -F "aspectRatio=16:9" \
  -F "media[]=@/absolute/path/to/reference.jpg"
```

### 视频参考生成

```bash
curl -X POST http://127.0.0.1:8790/tasks \
  -H "Authorization: Bearer change-me" \
  -F "prompt=continue the motion and keep the same subject identity" \
  -F "model=seedance_2" \
  -F "duration=5" \
  -F "resolution=720p" \
  -F "aspectRatio=16:9" \
  -F "media[]=@/absolute/path/to/reference.mp4"
```

### 图片 + 视频参考

```bash
curl -X POST http://127.0.0.1:8790/tasks \
  -H "Authorization: Bearer change-me" \
  -F "prompt=use the image as subject reference and the video as motion reference" \
  -F "model=seedance_2" \
  -F "duration=10" \
  -F "resolution=720p" \
  -F "aspectRatio=16:9" \
  -F "media[]=@/absolute/path/to/subject.jpg" \
  -F "media[]=@/absolute/path/to/motion.mp4"
```

成功响应：

```json
{
  "id": "b3c9e2c4-4d4d-4a97-9d79-000000000000",
  "runwayTaskId": null,
  "status": "pending",
  "accountId": null
}
```

这里的 `id` 是本地任务 ID，后续用它查询任务状态。

## 5. 查询任务状态

### `GET /tasks/:id`

```bash
curl -H "Authorization: Bearer change-me" \
  http://127.0.0.1:8790/tasks/<task-id>
```

完成前响应示例：

```json
{
  "id": "b3c9e2c4-4d4d-4a97-9d79-000000000000",
  "runwayTaskId": "runway-task-id",
  "status": "generating",
  "progress": 42,
  "videoUrl": null,
  "thumbnailUrl": null,
  "error": null
}
```

完成后响应示例：

```json
{
  "id": "b3c9e2c4-4d4d-4a97-9d79-000000000000",
  "runwayTaskId": "runway-task-id",
  "status": "completed",
  "progress": 100,
  "videoUrl": "https://...",
  "thumbnailUrl": "https://...",
  "error": null
}
```

任务失败示例：

```json
{
  "id": "b3c9e2c4-4d4d-4a97-9d79-000000000000",
  "status": "failed",
  "rawStatus": "FAILED",
  "errorSummary": "参考素材未通过内容审核",
  "errorCode": "SAFETY.INPUT.MULTIMODAL",
  "errorCategory": "SEXUALLY_EXPLICIT",
  "error": {
    "code": "SAFETY.INPUT.MULTIMODAL",
    "message": "Input media did not pass content moderation."
  }
}
```

失败时优先给业务方展示 `errorSummary`。`errorDetail` 和 `rawResponse` 会保留 Runway 原始返回，方便排查。

常见中文摘要：

| errorSummary | 说明 |
| --- | --- |
| `参考素材未通过内容审核` | 图片或视频参考素材未过审 |
| `提示词未通过内容审核` | prompt 文本未过审 |
| `账号凭证失效` | JWT/Cookie 不可用，需要刷新或重新导入 |
| `上传或请求超时` | 上传、S3 或请求超时 |
| `Runway 服务暂时不可用` | Runway 5xx 或临时服务错误 |

任务状态：

| status | 含义 |
| --- | --- |
| `pending` | 本地排队中 |
| `submitting` | 正在上传素材或提交 Runway |
| `queuing` | Runway 排队中 |
| `generating` | Runway 生成中 |
| `completed` | 已完成，读取 `videoUrl` |
| `failed` | 失败，读取 `error` |
| `cancelled` | 已取消 |

## 6. 查询任务时间线

### `GET /tasks/:id/events`

```bash
curl -H "Authorization: Bearer change-me" \
  http://127.0.0.1:8790/tasks/<task-id>/events
```

返回任务入队、账号分配、提交、状态变化、失败/完成等关键事件。历史任务没有事件记录时，服务会根据任务字段合成基础时间线。

## 7. 查询任务列表

### `GET /tasks`

```bash
curl -H "Authorization: Bearer change-me" \
  "http://127.0.0.1:8790/tasks?limit=20"
```

按状态筛选：

```bash
curl -H "Authorization: Bearer change-me" \
  "http://127.0.0.1:8790/tasks?status=completed&limit=20"
```

查询参数：

| 参数 | 说明 |
| --- | --- |
| `status` | 可选，按状态过滤 |
| `limit` | 可选，默认 `50`，最大 `200` |
| `offset` | 可选，分页偏移 |

## 8. 重试失败任务

### `POST /tasks/:id/retry`

只允许重试 `failed` 状态的任务。

```bash
curl -X POST http://127.0.0.1:8790/tasks/<task-id>/retry \
  -H "Authorization: Bearer change-me"
```

响应：

```json
{
  "id": "new-local-task-id",
  "runwayTaskId": null,
  "status": "pending",
  "accountId": "account-id"
}
```

## 9. Node.js 调用示例

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileFrom } from 'node-fetch';

const baseUrl = 'http://127.0.0.1:8790';
const apiKey = 'change-me';

const form = new FormData();
form.set('prompt', 'a cinematic product shot with slow camera movement');
form.set('model', 'seedance_2');
form.set('duration', '5');
form.set('resolution', '720p');
form.set('aspectRatio', '16:9');
form.set('generateAudio', 'true');
form.set('exploreMode', 'true');

const referencePath = '/absolute/path/to/reference.mp4';
form.append('media[]', await fileFrom(referencePath), path.basename(referencePath));

const createResp = await fetch(`${baseUrl}/v1/videos`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`
  },
  body: form
});

const task = await createResp.json();
console.log(task);

while (true) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const pollResp = await fetch(`${baseUrl}/v1/videos/${task.id}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const current = await pollResp.json();
  console.log(current.status, current.progress, current.video_url);
  if (['completed', 'failed', 'cancelled'].includes(current.status)) break;
}
```

如果使用 Node.js 20+ 原生 `fetch/FormData`，也可以用 `fs.openAsBlob` 组装文件：

```js
const blob = await fs.openAsBlob('/absolute/path/to/reference.mp4', { type: 'video/mp4' });
form.append('media[]', blob, 'reference.mp4');
```

## 10. Python 调用示例

```python
import time
import requests

BASE_URL = "http://127.0.0.1:8790"
API_KEY = "change-me"

headers = {"Authorization": f"Bearer {API_KEY}"}

with open("/absolute/path/to/reference.mp4", "rb") as f:
    resp = requests.post(
        f"{BASE_URL}/v1/videos",
        headers=headers,
        data={
            "prompt": "continue the motion and keep the same subject identity",
            "model": "seedance_2",
            "duration": "5",
            "resolution": "720p",
            "aspectRatio": "16:9",
            "generateAudio": "true",
            "exploreMode": "true",
            "accountId": "auto",
        },
        files=[
            ("media[]", ("reference.mp4", f, "video/mp4")),
        ],
    )

task = resp.json()
print(task)

while True:
    time.sleep(5)
    current = requests.get(f"{BASE_URL}/v1/videos/{task['id']}", headers=headers).json()
    print(current.get("status"), current.get("progress"), current.get("video_url"))
    if current.get("status") in ["completed", "failed", "cancelled"]:
        break
```

## 11. 账号管理接口

账号管理接口主要给中文后台使用，也可以用 API 调用。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/accounts` | 账号列表，不返回明文 JWT/Cookie |
| `GET` | `/api/accounts/:id` | 账号详情，返回 JWT/Cookie，用于编辑 |
| `POST` | `/api/accounts/manual` | 手动添加账号 |
| `PUT` | `/api/accounts/:id` | 修改账号配置和凭证 |
| `POST` | `/api/accounts/:id/refresh-jwt` | 用 Cookie 刷新 JWT |
| `GET` | `/api/accounts/:id/runway-credits` | 查询并缓存 Runway 额度 |
| `POST` | `/api/accounts/:id/reset-generation-usage` | 重置本地生成计数 |
| `GET` | `/api/accounts/export` | 导出账号 JSON，包含敏感凭证 |
| `POST` | `/api/accounts/import` | 导入账号 JSON |

注意：`/api/accounts/export` 导出的 JSON 包含 `jwt` 和 `cookieHeader`，不要提交到 Git。

`POST /api/accounts/import` 支持以下 JSON 结构：

```json
{ "accounts": [{ "name": "账号1", "jwt": "...", "cookieHeader": "...", "teamId": 1, "assetGroupId": "..." }] }
```

也支持直接传数组、`{ "account": {...} }` 或单个账号对象。字段兼容 `authorization`、`cookie`、`team_id`、`asset_group_id`、`sourceVersion`、嵌套 `credentials` 等常见格式；重复 `id` 会自动生成新账号 ID。返回值会包含 `imported`、`skipped` 和逐条 `errors`，方便定位导入失败原因。

## 12. 最小调用流程

1. 确保后台已有至少一个 `ready: true` 的 Runway 账号。
2. 调用 `POST /v1/videos` 创建任务。
3. 每 5 到 10 秒调用 `GET /v1/videos/:id` 查询状态。
4. 当 `status` 为 `completed` 时读取 `video_url`。
