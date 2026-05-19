# Runway API

Runway-only 私有 API 服务。它把 Runway Web 的上传、提交、轮询流程封装成内部 HTTP API，并提供中文管理后台、多账号负载、代理池、本地生成上限、请求日志和任务队列。

> 这不是 Runway 官方 API。服务复用你自己的 Runway Web 登录态、Cookie、JWT 和 Web 请求头，Runway 内部接口变化或账号风控都属于已知风险。

## 文档

- [服务器部署指南](./DEPLOYMENT.md)
- [业务 API 调用文档](./API.md)

## 功能

- 多 Runway 账号管理
- Web 登录抓取凭证，或手动粘贴 `Authorization/Cookie/teamId/assetGroupId`
- Cookie 有效时自动刷新 JWT
- 每账号默认并发 `2`
- 每账号本地生成数量上限，默认 `80`
- 最少负载优先分发任务
- 图片/视频参考上传
- 异步任务队列，失败原因中文摘要
- 代理池和账号级代理策略
- 请求日志、任务详情、任务事件时间线
- SQLite 持久化，适合单机生产部署

## 快速开始

```bash
git clone https://github.com/sukabubu/runway-api.git
cd runway-api/runway-api
npm install
cp .env.example .env
npm start
```

默认后台地址：

```text
http://127.0.0.1:8790/
```

默认管理员来自 `.env`：

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me
INTERNAL_API_KEY=change-me
```

第一次部署请务必修改 `ADMIN_PASSWORD` 和 `INTERNAL_API_KEY`。

## 服务器使用方式

普通无头服务器通常不能直接人工网页登录。推荐流程：

1. 在本地电脑运行本项目。
2. 用后台“新增网页登录”登录 Runway，或手动添加账号。
3. 在后台“账号管理”导出账号 JSON。
4. 部署到服务器后，在服务器后台导入账号 JSON。
5. 服务器上只要 Cookie 没失效，就能自动刷新 JWT，不需要常驻浏览器。

Cookie 失效后，需要重新网页登录并重新导入账号，或手动更新 Cookie/JWT。

## 业务调用示例

```bash
curl -X POST http://127.0.0.1:8790/tasks \
  -H "Authorization: Bearer change-me" \
  -F "prompt=a cinematic shot of waves at sunset" \
  -F "model=seedance_2" \
  -F "duration=5" \
  -F "resolution=720p" \
  -F "aspectRatio=16:9" \
  -F "media[]=@/absolute/path/to/reference.jpg"
```

查询任务：

```bash
curl -H "Authorization: Bearer change-me" \
  http://127.0.0.1:8790/tasks/<task-id>
```

## 账号导入导出

后台支持账号导入/导出 JSON。导出的 JSON 包含 `jwt` 和 `cookieHeader`，属于敏感凭证：

- 不要提交到 Git
- 不要发到公共聊天或工单
- 建议只在内网或 HTTPS 后台中导入导出
- 服务器备份时注意保护 `data/runway-api.sqlite`

导入支持导出的 `{ "accounts": [...] }` 格式，也支持账号数组、单个账号对象、`authorization` / `cookie` / `team_id` / `asset_group_id` 等常见字段名。导入完成后后台会提示成功和失败条数；如果某条账号格式不对，会显示具体第几条失败。

## 生产提示

第一阶段建议单机部署，一个主 worker 进程配 SQLite。SQLite 队列已经有 lease、过期锁恢复、卡死任务恢复和任务超时保护。

如果要多实例横向扩容，建议先把队列和状态存储换成 Redis/Postgres，避免多个进程直接抢同一个 SQLite 文件。
