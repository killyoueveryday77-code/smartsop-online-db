# SmartSOP Online Test Version

This package is a Node.js deployable version of SmartSOP with a basic SQLite database.

## What Is Stored

- Production contexts: work order number + shift
- Full app state: tickets, SOP signatures, forms, photos, AI events, notifications, training progress, equipment values
- Production contexts are also stored separately for quick work-order selection

## Local Run

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Deploy Notes

GitHub Pages cannot run this app because it needs the Node.js API and SQLite database. Push this folder to GitHub, then deploy the repo to a Node.js host.

Use any Node.js host that supports persistent disk storage, such as Render, Railway, Fly.io, or a VPS.

This repo includes `render.yaml` for Render deployment with a persistent SQLite disk.

### Railway

1. Create a Railway project from this GitHub repo.
2. Add a Volume to the web service so SQLite survives redeploys.
3. Set the Volume mount path to `/app/data`, or leave Railway's generated mount path and the app will use `RAILWAY_VOLUME_MOUNT_PATH`.
4. Generate a Railway public domain from Settings -> Networking -> Public Networking.
5. For CLI deploys from a non-interactive environment, set `RAILWAY_TOKEN` or `RAILWAY_API_TOKEN`.

The repo includes `railway.json` with:

- Railpack builder
- `npm start`
- `/api/health` health check
- restart on failure

Start command:

```bash
npm start
```

Manual CLI deploy:

```powershell
$env:RAILWAY_TOKEN="your-token"
.\scripts\deploy-railway.ps1
```

If the local directory is not linked to the Railway project, pass IDs from the Railway dashboard:

```powershell
.\scripts\deploy-railway.ps1 -Project "<project-id>" -Service "<service-id>" -Environment "production"
```

The SQLite database is created at:

```text
data/smartsop.sqlite
```

If the hosting platform uses ephemeral storage, configure a persistent disk and set:

```text
DATA_DIR=/path/to/persistent/data
```

## API

```text
GET  /api/health
GET  /api/contexts
POST /api/contexts
GET  /api/state
PUT  /api/state
```

The static `file://` HTML still works in offline demo mode. Database sync is enabled when the app is opened through `http://` or `https://`.
