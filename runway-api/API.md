# 视频生成 API 调用文档

本文档只说明外部业务方如何调用本服务生成视频。默认服务地址：

```text
http://127.0.0.1:8787
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

## 1. 查看可用模型

### `GET /models`

```bash
curl http://127.0.0.1:8787/models
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

## 2. 创建视频任务

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
curl -X POST http://127.0.0.1:8787/tasks \
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
curl -X POST http://127.0.0.1:8787/tasks \
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
curl -X POST http://127.0.0.1:8787/tasks \
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
curl -X POST http://127.0.0.1:8787/tasks \
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

## 3. 查询任务状态

### `GET /tasks/:id`

```bash
curl -H "Authorization: Bearer change-me" \
  http://127.0.0.1:8787/tasks/<task-id>
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
  "error": {
    "code": "SUBMIT_FAILED",
    "message": "失败原因"
  }
}
```

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

## 4. 查询任务列表

### `GET /tasks`

```bash
curl -H "Authorization: Bearer change-me" \
  "http://127.0.0.1:8787/tasks?limit=20"
```

按状态筛选：

```bash
curl -H "Authorization: Bearer change-me" \
  "http://127.0.0.1:8787/tasks?status=completed&limit=20"
```

查询参数：

| 参数 | 说明 |
| --- | --- |
| `status` | 可选，按状态过滤 |
| `limit` | 可选，默认 `50`，最大 `200` |
| `offset` | 可选，分页偏移 |

## 5. 重试失败任务

### `POST /tasks/:id/retry`

只允许重试 `failed` 状态的任务。

```bash
curl -X POST http://127.0.0.1:8787/tasks/<task-id>/retry \
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

## 6. Node.js 调用示例

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileFrom } from 'node-fetch';

const baseUrl = 'http://127.0.0.1:8787';
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

const createResp = await fetch(`${baseUrl}/tasks`, {
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
  const pollResp = await fetch(`${baseUrl}/tasks/${task.id}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const current = await pollResp.json();
  console.log(current.status, current.progress, current.videoUrl);
  if (['completed', 'failed', 'cancelled'].includes(current.status)) break;
}
```

如果使用 Node.js 20+ 原生 `fetch/FormData`，也可以用 `fs.openAsBlob` 组装文件：

```js
const blob = await fs.openAsBlob('/absolute/path/to/reference.mp4', { type: 'video/mp4' });
form.append('media[]', blob, 'reference.mp4');
```

## 7. Python 调用示例

```python
import time
import requests

BASE_URL = "http://127.0.0.1:8787"
API_KEY = "change-me"

headers = {"Authorization": f"Bearer {API_KEY}"}

with open("/absolute/path/to/reference.mp4", "rb") as f:
    resp = requests.post(
        f"{BASE_URL}/tasks",
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
    current = requests.get(f"{BASE_URL}/tasks/{task['id']}", headers=headers).json()
    print(current.get("status"), current.get("progress"), current.get("videoUrl"))
    if current.get("status") in ["completed", "failed", "cancelled"]:
        break
```

## 8. 最小调用流程

1. 确保后台已有至少一个 `ready: true` 的 Runway 账号。
2. 调用 `POST /tasks` 创建任务。
3. 每 5 到 10 秒调用 `GET /tasks/:id` 查询状态。
4. 当 `status` 为 `completed` 时读取 `videoUrl`。
