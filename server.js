const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const Database = require("better-sqlite3");

const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || "0.0.0.0";
const dataDir =
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "smartsop.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS production_contexts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL,
    shift TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(order_no, shift)
  );

  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const seedContext = db.prepare(`
  INSERT OR IGNORE INTO production_contexts (order_no, shift)
  VALUES (?, ?)
`);
seedContext.run("MO-2026050408", "08:00-16:00");

app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    database: "sqlite",
    now: new Date().toISOString(),
    railway: {
      commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
      branch: process.env.RAILWAY_GIT_BRANCH || null,
      deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null
    }
  });
});

app.get("/api/contexts", (_req, res) => {
  const rows = db.prepare(`
    SELECT id, order_no AS orderNo, shift, created_at AS createdAt
    FROM production_contexts
    ORDER BY id DESC
  `).all();
  res.json({ contexts: rows });
});

app.post("/api/contexts", (req, res) => {
  const orderNo = String(req.body.orderNo || "").trim();
  const shift = String(req.body.shift || "").trim();
  if (!orderNo || !shift) {
    res.status(400).json({ error: "orderNo and shift are required" });
    return;
  }

  db.prepare(`
    INSERT OR IGNORE INTO production_contexts (order_no, shift)
    VALUES (?, ?)
  `).run(orderNo, shift);

  const row = db.prepare(`
    SELECT id, order_no AS orderNo, shift, created_at AS createdAt
    FROM production_contexts
    WHERE order_no = ? AND shift = ?
  `).get(orderNo, shift);
  res.status(201).json({ context: row });
});

app.get("/api/state", (_req, res) => {
  const row = db.prepare("SELECT payload, updated_at AS updatedAt FROM app_state WHERE id = 1").get();
  res.json(row ? { state: JSON.parse(row.payload), updatedAt: row.updatedAt } : { state: null });
});

app.put("/api/state", (req, res) => {
  const payload = JSON.stringify(req.body || {});
  db.prepare(`
    INSERT INTO app_state (id, payload, updated_at)
    VALUES (1, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP
  `).run(payload);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function localNetworkUrls(portNumber) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net && net.family === "IPv4" && !net.internal)
    .map((net) => `http://${net.address}:${portNumber}`);
}

app.listen(port, host, () => {
  console.log(`SmartSOP server listening on http://localhost:${port}`);
  console.log(`SQLite data directory: ${dataDir}`);
  for (const url of localNetworkUrls(port)) {
    console.log(`LAN test URL: ${url}`);
  }
});
