# Runway API

Runway-only 私有 API 服务。它把 Runway Web 的上传、提交、轮询流程封装成内部 HTTP API，并提供中文管理后台、多账号负载、代理池、每日生成上限、请求日志和任务队列。

> 这不是 Runway 官方 API。服务复用你自己的 Runway Web 登录态、Cookie、JWT 和 Web 请求头，Runway 内部接口变化或账号风控都属于已知风险。

## 文档

- [服务器部署指南](./DEPLOYMENT.md)
- [业务 API 调用文档](./API.md)

## 功能

- 多 Runway 账号管理
- Web 登录抓取凭证，或手动粘贴 `Authorization/Cookie/teamId/assetGroupId`
- Cookie 有效时自动刷新 JWT
- 每账号默认并发 `2`
- 每账号每日生成数量上限，默认 `80`，按北京时间自然日自动刷新
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

推荐使用 OpenAI 兼容 `/v1` 接口：

```bash
curl -X POST http://127.0.0.1:8790/v1/videos \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"model":"seedance_2","prompt":"a cinematic shot of waves at sunset","duration":5,"resolution":"720p","aspectRatio":"16:9","media_urls":["https://example.com/reference.jpg"]}'
```

参考素材优先传 URL：`media_urls` / `mediaUrls` / `reference_urls` / `referenceUrls` 都支持。如果要模仿 Runway 网页的 `@素材名` 写法，可以传：

未手动命名的素材会按上传顺序自动命名：图片是 `IMG_1`、`IMG_2`，视频是 `VID_1`、`VID_2`。因此可以直接在提示词里写 `@IMG_1`、`@VID_1`；如果传了 `references[].name`，则优先使用你指定的名字。

```json
{
  "prompt": "使用 @IMG_1 作为主体外观，使用 @VID_1 作为运动参考",
  "media_urls": [
    "https://example.com/subject.jpg",
    "https://example.com/motion.mp4"
  ]
}
```

必须上传本地文件时仍然可以用 `multipart/form-data`：

```bash
curl -X POST http://127.0.0.1:8790/v1/videos \
  -H "Authorization: Bearer change-me" \
  -F "prompt=a cinematic shot of waves at sunset" \
  -F "model=seedance_2" \
  -F "duration=5" \
  -F "resolution=720p" \
  -F "aspectRatio=16:9" \
  -F "media_urls=https://example.com/reference.jpg" \
  -F "media[]=@/absolute/path/to/reference.jpg"
```

查询任务：

```bash
curl -H "Authorization: Bearer change-me" \
  http://127.0.0.1:8790/v1/videos/<task-id>
```

## 账号导入导出

后台支持账号导入/导出 JSON。导出的 JSON 包含 `jwt` 和 `cookieHeader`，属于敏感凭证：

- 不要提交到 Git
- 不要发到公共聊天或工单
- 建议只在内网或 HTTPS 后台中导入导出
- 服务器备份时注意保护 `data/runway-api.sqlite`

导入支持导出的 `{ "accounts": [...] }` 格式，也支持账号数组、单个账号对象、`authorization` / `cookie` / `team_id` / `asset_group_id` 等常见字段名。导入完成后后台会提示成功和失败条数；如果某条账号格式不对，会显示具体第几条失败。

## Chrome 插件直接导入

仓库内置本地自用插件：`runway-credential-extension/`。它会监听你浏览器里的 `api.runwayml.com` 请求，抓取 `Authorization`、`Cookie`、`teamId`、`assetGroupId`、`clientId` 和 source version，然后直接导入到你的 runway-api 服务器。

安装方式：

1. Chrome 打开 `chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择 `runway-credential-extension/`
5. 打开并登录 Runway，进入生成页或刷新页面
6. 点击插件图标，填写项目服务器地址和 `INTERNAL_API_KEY`
7. 点击“直接导入”

服务端接口是 `POST /api/plugin/accounts/import`，需要 `Authorization: Bearer <INTERNAL_API_KEY>`。插件只在你点击“直接导入”时发送凭证；也可以点击“复制 JSON”走后台手动导入。

如果在 Codex 内嵌的自动化 Chrome 里测试，可能会看到“扩展程序已加载”但列表没有卡片。那通常是浏览器进程带了 `--disable-extensions` 启动参数，扩展被 Chrome 直接禁用；请用你正常打开的 Chrome 安装插件。部署到服务器时，本地插件仍然可以用：服务器地址填你的 HTTPS 域名，本地调试填 `http://127.0.0.1:8790`。

如果 Chrome 提示加载成功但列表没有卡片，优先检查三点：

1. 确认选择的是包含 `manifest.json` 的目录本身，而不是仓库根目录。
2. 地址栏打开 `chrome://policy`，确认没有 `ExtensionInstallBlocklist` 或禁用开发者扩展的策略。
3. 如果仍然不显示，把 `runway-credential-extension/` 复制到一个普通目录，例如桌面，再重新加载。插件默认只申请 Runway 和本地服务权限，远端服务器导入由服务端 CORS 支持，不需要申请所有网站权限。

## 生产提示

第一阶段建议单机部署，一个主 worker 进程配 SQLite。SQLite 队列已经有 lease、过期锁恢复、卡死任务恢复和任务超时保护。

如果要多实例横向扩容，建议先把队列和状态存储换成 Redis/Postgres，避免多个进程直接抢同一个 SQLite 文件。
