# 服务器部署指南

本文说明如何把 `runway-api` 部署到服务器上长期运行。

## 1. 环境要求

- Node.js `>= 18.18`
- npm
- 一台能访问 Runway 的服务器
- 建议使用反向代理和 HTTPS，例如 Nginx/Caddy

## 2. 拉取代码

```bash
git clone https://github.com/sukabubu/runway-api.git
cd runway-api/runway-api
npm install
```

## 3. 配置环境变量

```bash
cp .env.example .env
```

至少修改这些值：

```env
HOST=127.0.0.1
PORT=8790
INTERNAL_API_KEY=replace-with-a-long-random-key
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-strong-password
DATA_DIR=./data
```

常用配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。公网部署建议配反向代理，不建议直接暴露 |
| `PORT` | `8790` | 服务端口 |
| `INTERNAL_API_KEY` | `change-me` | 业务 API Bearer Key |
| `ADMIN_USERNAME` | `admin` | 后台登录账号 |
| `ADMIN_PASSWORD` | `change-me` | 后台登录密码 |
| `DATA_DIR` | `./data` | 数据目录 |
| `DB_PATH` | `./data/runway-api.sqlite` | SQLite 路径 |
| `UPLOAD_DIR` | `./data/uploads` | 上传素材保存目录 |
| `BROWSER_PROFILES_DIR` | `./data/browser-profiles` | Playwright 账号 profile |
| `RUNWAY_ACCOUNT_CONCURRENCY` | `2` | 新账号默认并发 |
| `RUNWAY_TASK_TIMEOUT_MS` | `1500000` | 任务最大运行时间 |
| `RUNWAY_UPSTREAM_AUTO_RETRY_ATTEMPTS` | `3` | 上游临时失败自动重试最大尝试次数 |
| `LOG_RETENTION_DAYS` | `14` | 请求日志保留天数 |
| `UPLOAD_RETENTION_DAYS` | `7` | 完成/失败任务素材保留天数 |

## 4. 启动服务

开发启动：

```bash
npm start
```

生产建议用 systemd 或 pm2 守护进程。

### systemd 示例

假设项目路径是 `/opt/runway-api/runway-api`：

```ini
[Unit]
Description=Runway API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/runway-api/runway-api
EnvironmentFile=/opt/runway-api/runway-api/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

保存为 `/etc/systemd/system/runway-api.service` 后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable runway-api
sudo systemctl start runway-api
sudo systemctl status runway-api
```

## 5. 反向代理

建议只让 Node 服务监听 `127.0.0.1`，由 Nginx/Caddy 提供 HTTPS。

Nginx 示例：

```nginx
server {
  listen 80;
  server_name your-domain.example;

  location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## 6. 账号迁移到服务器

无头服务器通常不适合直接点“新增网页登录”。推荐：

1. 在本地电脑启动服务。
2. 后台网页登录 Runway，等账号显示“凭证完整”。
3. 在本地后台“导出 JSON”。
4. 登录服务器后台，点击“导入 JSON”。
5. 服务器上任务会使用导入的 Cookie/JWT。

只要 Cookie 有效，服务可以自动刷新 JWT。Cookie 失效后，需要重新登录并重新导入，或手动更新账号详情里的 Cookie/JWT。

## 7. 数据和备份

重要运行数据都在 `DATA_DIR`：

```text
data/runway-api.sqlite
data/uploads/
data/browser-profiles/
```

备份时至少备份：

```text
data/runway-api.sqlite
```

如果需要保留浏览器登录 profile，也备份：

```text
data/browser-profiles/
```

这些目录包含账号凭证或任务素材，不要上传到 GitHub。

## 8. 安全建议

- 修改默认 `ADMIN_PASSWORD`
- 修改默认 `INTERNAL_API_KEY`
- 后台不要裸露在公网，至少加 HTTPS
- 最好再加一层 Nginx Basic Auth、IP 白名单或 VPN
- 不要把账号导出 JSON、`.env`、`data/` 发给别人
- 公开仓库只包含代码，真实凭证只保存在服务器 `.env` 和 SQLite 中

## 9. 高并发建议

当前版本定位是“单机生产稳定”：

- SQLite 开启 WAL
- 任务领取使用 lease
- 支持过期锁恢复
- 支持任务超时失败
- 启动时会重建账号 inflight

建议一个 SQLite 数据库只跑一个主 worker 进程。若要多机或多 worker 横向扩容，建议后续切到 Redis/BullMQ 或 Postgres 队列。
