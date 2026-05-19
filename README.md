# Runway API

Runway-only 私有 API 服务，项目代码在 [`runway-api/`](./runway-api/) 目录。

## 文档

- [项目说明](./runway-api/README.md)
- [服务器部署指南](./runway-api/DEPLOYMENT.md)
- [业务 API 调用文档](./runway-api/API.md)

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

部署前请修改 `.env` 里的 `ADMIN_PASSWORD` 和 `INTERNAL_API_KEY`。

## 安全提醒

不要提交或公开：

- `.env`
- `data/`
- SQLite 数据库
- 账号导出的 JSON
- 浏览器 profile
- 上传素材

这些文件可能包含 Runway Cookie、JWT 或任务素材。
