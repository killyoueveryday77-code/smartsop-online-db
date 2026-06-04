const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
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

  CREATE TABLE IF NOT EXISTS audit_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'system',
    status TEXT NOT NULL DEFAULT 'recorded',
    severity TEXT NOT NULL DEFAULT 'info',
    result TEXT NOT NULL,
    confidence REAL,
    operator TEXT,
    signer TEXT,
    batch_id TEXT,
    step_idx INTEGER,
    check_idx INTEGER,
    equipment_id TEXT,
    photo TEXT,
    parameters TEXT,
    payload TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_records_created_at
    ON audit_records(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_records_type
    ON audit_records(type);

  CREATE TABLE IF NOT EXISTS equipment_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipment_id TEXT NOT NULL,
    reading_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source TEXT NOT NULL DEFAULT 'manual',
    temperature REAL,
    rpm REAL,
    moisture REAL,
    metal_detect TEXT,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_equipment_readings_equipment_time
    ON equipment_readings(equipment_id, reading_at DESC);

  CREATE TABLE IF NOT EXISTS signature_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    kind TEXT NOT NULL,
    batch_id TEXT,
    shift TEXT,
    step_idx INTEGER,
    form_id TEXT,
    signer TEXT NOT NULL,
    role TEXT,
    status TEXT NOT NULL DEFAULT 'signed',
    signature_text TEXT,
    signature_hash TEXT NOT NULL,
    statement TEXT,
    payload TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_signature_records_batch
    ON signature_records(batch_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_signature_records_step
    ON signature_records(batch_id, step_idx, created_at DESC);
`);

const seedContext = db.prepare(`
  INSERT OR IGNORE INTO production_contexts (order_no, shift)
  VALUES (?, ?)
`);
seedContext.run("MO-2026050408", "08:00-16:00");

app.use(express.json({ limit: process.env.JSON_LIMIT || "25mb" }));

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

function normalizeIsoDate(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requireIngestToken(req, res) {
  const expected = process.env.EQUIPMENT_INGEST_TOKEN;
  if (!expected) return true;
  const actual =
    req.get("x-ingest-token") ||
    req.get("x-api-key") ||
    String(req.query.token || "");
  if (actual === expected) return true;
  res.status(401).json({ error: "Invalid equipment ingest token" });
  return false;
}

function normalizeEquipmentReading(input) {
  const body = input || {};
  const values = { ...(body.values || {}) };
  for (const key of [
    "rpm",
    "temp",
    "temperature",
    "screw_t",
    "die_t",
    "current",
    "runtime",
    "belt",
    "blade",
    "width",
    "moisture",
    "metal_detect",
    "metalDetect"
  ]) {
    if (body[key] !== undefined && values[key] === undefined) {
      values[key] = body[key];
    }
  }

  return {
    equipmentId: String(body.equipmentId || body.equipment_id || body.id || "").trim(),
    readingAt: normalizeIsoDate(body.readingAt || body.reading_at || body.timestamp || body.time),
    source: String(body.source || "manual").trim() || "manual",
    values,
    raw: body
  };
}

function insertEquipmentReading(input) {
  const reading = normalizeEquipmentReading(input);
  if (!reading.equipmentId) {
    throw new Error("equipmentId is required");
  }

  const temperature =
    numericOrNull(reading.values.temperature) ??
    numericOrNull(reading.values.temp) ??
    numericOrNull(reading.values.die_t) ??
    numericOrNull(reading.values.screw_t);
  const rpm = numericOrNull(reading.values.rpm) ?? numericOrNull(reading.values.blade);
  const moisture = numericOrNull(reading.values.moisture);
  const metalDetect =
    reading.values.metal_detect !== undefined
      ? String(reading.values.metal_detect)
      : reading.values.metalDetect !== undefined
        ? String(reading.values.metalDetect)
        : null;

  const result = db.prepare(`
    INSERT INTO equipment_readings (
      equipment_id, reading_at, source, temperature, rpm, moisture, metal_detect, payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reading.equipmentId,
    reading.readingAt,
    reading.source,
    temperature,
    rpm,
    moisture,
    metalDetect,
    JSON.stringify({
      equipmentId: reading.equipmentId,
      readingAt: reading.readingAt,
      source: reading.source,
      values: reading.values,
      raw: reading.raw
    })
  );

  return { id: result.lastInsertRowid, ...reading };
}

function equipmentRowToReading(row) {
  const payload = parseJson(row.payload, {});
  return {
    id: row.id,
    equipmentId: row.equipment_id,
    readingAt: row.reading_at,
    source: row.source,
    values: payload.values || {},
    temperature: row.temperature,
    rpm: row.rpm,
    moisture: row.moisture,
    metalDetect: row.metal_detect,
    raw: payload.raw || null
  };
}

function auditRowToRecord(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    type: row.type,
    source: row.source,
    status: row.status,
    severity: row.severity,
    result: row.result,
    confidence: row.confidence,
    operator: row.operator,
    signer: row.signer,
    batchId: row.batch_id,
    stepIdx: row.step_idx,
    checkIdx: row.check_idx,
    equipmentId: row.equipment_id,
    photo: row.photo,
    parameters: parseJson(row.parameters, null),
    payload: parseJson(row.payload, null)
  };
}

function signatureRowToRecord(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    batchId: row.batch_id,
    shift: row.shift,
    stepIdx: row.step_idx,
    formId: row.form_id,
    signer: row.signer,
    role: row.role,
    status: row.status,
    signatureText: row.signature_text,
    signatureHash: row.signature_hash,
    statement: row.statement,
    payload: parseJson(row.payload, null)
  };
}

function buildSignatureHash(record) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(record))
    .digest("hex");
}

async function readExternalEquipmentSource() {
  if (process.env.EQUIPMENT_SOURCE_URL) {
    const response = await fetch(process.env.EQUIPMENT_SOURCE_URL, {
      headers: process.env.EQUIPMENT_SOURCE_TOKEN
        ? { Authorization: `Bearer ${process.env.EQUIPMENT_SOURCE_TOKEN}` }
        : undefined
    });
    if (!response.ok) {
      throw new Error(`Equipment source returned ${response.status}`);
    }
    return response.json();
  }

  if (process.env.EQUIPMENT_SOURCE_FILE) {
    return JSON.parse(fs.readFileSync(process.env.EQUIPMENT_SOURCE_FILE, "utf8"));
  }

  return null;
}

async function latestEquipmentReadings() {
  const external = await readExternalEquipmentSource();
  if (external) {
    const readings = Array.isArray(external)
      ? external
      : external.readings || external.equipment || [];
    return {
      source: process.env.EQUIPMENT_SOURCE_URL ? "external-url" : "external-file",
      sourceConfigured: true,
      readings: readings.map(normalizeEquipmentReading)
    };
  }

  const rows = db.prepare(`
    SELECT er.*
    FROM equipment_readings er
    INNER JOIN (
      SELECT equipment_id, MAX(id) AS id
      FROM equipment_readings
      GROUP BY equipment_id
    ) latest ON latest.id = er.id
    ORDER BY er.equipment_id
  `).all();

  return {
    source: rows.length ? "database" : "local-snapshot",
    sourceConfigured: false,
    readings: rows.map(equipmentRowToReading)
  };
}

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

app.get("/api/audit/records", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const rows = db.prepare(`
    SELECT *
    FROM audit_records
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
  res.json({ records: rows.map(auditRowToRecord) });
});

app.post("/api/audit/records", (req, res) => {
  const body = req.body || {};
  const parameters = body.parameters || null;
  const payload = body.payload || null;
  const result = db.prepare(`
    INSERT INTO audit_records (
      type, source, status, severity, result, confidence, operator, signer,
      batch_id, step_idx, check_idx, equipment_id, photo, parameters, payload
    )
    VALUES (
      @type, @source, @status, @severity, @result, @confidence, @operator, @signer,
      @batchId, @stepIdx, @checkIdx, @equipmentId, @photo, @parameters, @payload
    )
  `).run({
    type: String(body.type || "general"),
    source: String(body.source || "smart-audit"),
    status: String(body.status || "recorded"),
    severity: String(body.severity || "info"),
    result: String(body.result || "UNKNOWN"),
    confidence: numericOrNull(body.confidence),
    operator: body.operator ? String(body.operator) : null,
    signer: body.signer ? String(body.signer) : null,
    batchId: body.batchId ? String(body.batchId) : null,
    stepIdx: Number.isInteger(body.stepIdx) ? body.stepIdx : numericOrNull(body.stepIdx),
    checkIdx: Number.isInteger(body.checkIdx) ? body.checkIdx : numericOrNull(body.checkIdx),
    equipmentId: body.equipmentId ? String(body.equipmentId) : null,
    photo: body.photo ? String(body.photo) : null,
    parameters: parameters ? JSON.stringify(parameters) : null,
    payload: payload ? JSON.stringify(payload) : null
  });

  const row = db.prepare("SELECT * FROM audit_records WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json({ record: auditRowToRecord(row) });
});

app.get("/api/signatures", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const batchId = String(req.query.batchId || "").trim();
  const rows = batchId
    ? db.prepare(`
        SELECT *
        FROM signature_records
        WHERE batch_id = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(batchId, limit)
    : db.prepare(`
        SELECT *
        FROM signature_records
        ORDER BY id DESC
        LIMIT ?
      `).all(limit);
  res.json({ signatures: rows.map(signatureRowToRecord) });
});

app.post("/api/signatures", (req, res) => {
  const body = req.body || {};
  const signer = String(body.signer || "").trim();
  if (!signer) {
    res.status(400).json({ error: "signer is required" });
    return;
  }

  const payload = body.payload || {};
  const canonical = {
    kind: String(body.kind || "sop-step"),
    batchId: body.batchId ? String(body.batchId) : null,
    shift: body.shift ? String(body.shift) : null,
    stepIdx: Number.isInteger(body.stepIdx) ? body.stepIdx : numericOrNull(body.stepIdx),
    formId: body.formId ? String(body.formId) : null,
    signer,
    role: body.role ? String(body.role) : null,
    status: String(body.status || "signed"),
    signatureText: body.signatureText ? String(body.signatureText) : signer,
    statement: body.statement ? String(body.statement) : "I confirm this SOP step was completed and reviewed.",
    payload
  };
  const signatureHash = buildSignatureHash(canonical);

  const transaction = db.transaction(() => {
    const signatureResult = db.prepare(`
      INSERT INTO signature_records (
        kind, batch_id, shift, step_idx, form_id, signer, role, status,
        signature_text, signature_hash, statement, payload
      )
      VALUES (
        @kind, @batchId, @shift, @stepIdx, @formId, @signer, @role, @status,
        @signatureText, @signatureHash, @statement, @payload
      )
    `).run({
      ...canonical,
      signatureHash,
      payload: JSON.stringify(payload)
    });

    db.prepare(`
      INSERT INTO audit_records (
        type, source, status, severity, result, confidence, operator, signer,
        batch_id, step_idx, check_idx, equipment_id, photo, parameters, payload
      )
      VALUES (
        'signature', 'electronic-signature', 'recorded', 'info', 'SIGNED', 100,
        @operator, @signer, @batchId, @stepIdx, NULL, NULL, NULL, @parameters, @payload
      )
    `).run({
      operator: canonical.role || signer,
      signer,
      batchId: canonical.batchId,
      stepIdx: canonical.stepIdx,
      parameters: JSON.stringify({
        kind: canonical.kind,
        shift: canonical.shift,
        formId: canonical.formId,
        signatureHash
      }),
      payload: JSON.stringify({
        signatureId: signatureResult.lastInsertRowid,
        statement: canonical.statement,
        payload
      })
    });

    return db
      .prepare("SELECT * FROM signature_records WHERE id = ?")
      .get(signatureResult.lastInsertRowid);
  });

  const row = transaction();
  res.status(201).json({ signature: signatureRowToRecord(row) });
});

app.get("/api/equipment/latest", async (_req, res) => {
  try {
    const data = await latestEquipmentReadings();
    res.json(data);
  } catch (error) {
    res.status(502).json({
      error: "Unable to read equipment source",
      detail: error.message,
      sourceConfigured: Boolean(process.env.EQUIPMENT_SOURCE_URL || process.env.EQUIPMENT_SOURCE_FILE),
      readings: []
    });
  }
});

app.get("/api/equipment/readings", (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const rows = db.prepare(`
    SELECT *
    FROM equipment_readings
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
  res.json({ readings: rows.map(equipmentRowToReading) });
});

app.post("/api/equipment/readings", (req, res) => {
  if (!requireIngestToken(req, res)) return;
  const body = req.body || {};
  const input = Array.isArray(body) ? body : body.readings || [body];
  try {
    const readings = input.map(insertEquipmentReading);
    res.status(201).json({ ok: true, readings });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
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
