# Runway API

Private Runway-only API service extracted from the Runway REST flow in `seedance-runway`.

完整接口调用说明见 [API.md](./API.md)。

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Then open the admin console:

```text
http://127.0.0.1:8790/
```

Log in with the configured admin account, then use the console to manage Runway accounts, proxies, tasks, runtime settings, and logs.

Open the login browser:

```bash
curl -H "Authorization: Bearer change-me" http://127.0.0.1:8790/auth/open-runway
```

After logging into Runway, check credential capture:

```bash
curl -H "Authorization: Bearer change-me" http://127.0.0.1:8790/auth/status
```

Submit a task:

```bash
curl -X POST http://127.0.0.1:8790/tasks \
  -H "Authorization: Bearer change-me" \
  -F "prompt=a cinematic shot of waves at sunset" \
  -F "model=seedance_2" \
  -F "duration=5" \
  -F "resolution=480p" \
  -F "aspectRatio=16:9" \
  -F "media[]=@/absolute/path/to/reference.jpg" \
  -F "media[]=@/absolute/path/to/reference.mp4"
```

Poll:

```bash
curl -H "Authorization: Bearer change-me" http://127.0.0.1:8790/tasks/<id>
```

## Notes

This service uses Runway Web session credentials captured from a persistent Playwright browser. It is not an official Runway API client. Internal endpoints and account risk can change at any time.

For production on one server, run a single main worker process against the SQLite database. The queue uses SQLite leases and stale-task recovery for single-server safety; switch the queue/storage adapters to Redis/Postgres before horizontal multi-instance workers.
