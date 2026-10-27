const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));

const required = ["DATABASE_URL", "ADMIN_USERNAME", "ADMIN_PASSWORD", "JWT_SECRET"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Configuration manquante : ${key}`);
    process.exit(1);
  }
}

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origine non autorisée par CORS"));
  },
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /neon\.tech|render\.com/i.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gdsp_championship_data (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      drivers JSONB NOT NULL DEFAULT '[]'::jsonb,
      penalties JSONB NOT NULL DEFAULT '[]'::jsonb,
      championship JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT
    )
  `);
  await pool.query(`ALTER TABLE gdsp_championship_data ADD COLUMN IF NOT EXISTS championship JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`
    INSERT INTO gdsp_championship_data (id, drivers, penalties, championship)
    VALUES (1, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Connexion administrateur requise." });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: "Session expirée ou invalide. Reconnecte-toi." });
  }
}

function validatePayload(body) {
  if (!body || !Array.isArray(body.drivers) || !Array.isArray(body.penalties || [])) {
    return "Le corps doit contenir les tableaux drivers et penalties.";
  }
  if (body.drivers.length > 1000 || (body.penalties || []).length > 10000) {
    return "Le nombre d'éléments dépasse la limite autorisée.";
  }
  for (const d of body.drivers) {
    const name = String(d?.name ?? "").trim();
    const points = Number(d?.points);
    if (!name || name.length > 160 || !Number.isFinite(points)) {
      return "Chaque pilote doit avoir un nom et un nombre de points valide.";
    }
  }
  return null;
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "gdsp-lola-t290-api", database: "connected" });
  } catch {
    res.status(503).json({ ok: false, database: "unavailable" });
  }
});


function isNonEmptyObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

// Compatibility routes for the existing GDSP frontend; the full championship
// JSON is stored separately so the existing results/penalties API remains intact.
app.post("/api/admin/login", async (req, res) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPassword = process.env.ADMIN_PASSWORD;
  const validUser = username === expectedUser;
  const validPassword = await bcrypt.compare(password, expectedPassword.startsWith("$2")
    ? expectedPassword
    : await bcrypt.hash(expectedPassword, 10));
  if (!validUser || !validPassword) {
    return res.status(401).json({ error: "Identifiant ou mot de passe incorrect." });
  }
  const token = jwt.sign({ sub: expectedUser, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "8h" });
  return res.json({ token, expiresIn: 28800 });
});

app.get("/api/championship", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT championship, updated_at FROM gdsp_championship_data WHERE id = 1");
    return res.json({ championship: rows[0]?.championship || {}, updatedAt: rows[0]?.updated_at || null });
  } catch (error) {
    console.error("GET championship:", error.message);
    return res.status(500).json({ error: "Impossible de lire le championnat." });
  }
});

app.post("/api/save-championship", requireAuth, async (req, res) => {
  if (!isNonEmptyObject(req.body)) return res.status(400).json({ error: "Championnat JSON invalide." });
  const payload = JSON.stringify(req.body);
  try {
    const { rows } = await pool.query(`
      INSERT INTO gdsp_championship_data (id, championship, updated_at, updated_by)
      VALUES (1, $1::jsonb, NOW(), $2)
      ON CONFLICT (id) DO UPDATE SET
        championship = EXCLUDED.championship,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
      RETURNING updated_at
    `, [payload, req.admin.sub]);
    return res.json({ status: "ok", message: "Championnat enregistré dans PostgreSQL.", updatedAt: rows[0].updated_at });
  } catch (error) {
    console.error("SAVE championship:", error.message);
    return res.status(500).json({ error: "Impossible d'enregistrer le championnat dans PostgreSQL." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPassword = process.env.ADMIN_PASSWORD;
  const validUser = username === expectedUser;
  const validPassword = await bcrypt.compare(password, expectedPassword.startsWith("$2")
    ? expectedPassword
    : await bcrypt.hash(expectedPassword, 10));
  if (!validUser || !validPassword) {
    return res.status(401).json({ error: "Identifiant ou mot de passe incorrect." });
  }
  const token = jwt.sign({ sub: expectedUser, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "8h" });
  return res.json({ token, expiresIn: 28800 });
});

app.get("/api/results", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT drivers, penalties, updated_at FROM gdsp_championship_data WHERE id = 1"
    );
    const row = rows[0];
    return res.json({
      drivers: row?.drivers || [],
      penalties: row?.penalties || [],
      updatedAt: row?.updated_at || null
    });
  } catch (error) {
    console.error("GET results:", error.message);
    return res.status(500).json({ error: "Impossible de lire les résultats." });
  }
});

app.put("/api/results", requireAuth, async (req, res) => {
  const validationError = validatePayload(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  try {
    const drivers = JSON.stringify(req.body.drivers);
    const penalties = JSON.stringify(req.body.penalties || []);
    const { rows } = await pool.query(`
      INSERT INTO gdsp_championship_data (id, drivers, penalties, updated_at, updated_by)
      VALUES (1, $1::jsonb, $2::jsonb, NOW(), $3)
      ON CONFLICT (id) DO UPDATE SET
        drivers = EXCLUDED.drivers,
        penalties = EXCLUDED.penalties,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
      RETURNING updated_at
    `, [drivers, penalties, req.admin.sub]);
    return res.json({ ok: true, updatedAt: rows[0].updated_at });
  } catch (error) {
    console.error("PUT results:", error.message);
    return res.status(500).json({ error: "Impossible d'enregistrer les résultats dans PostgreSQL." });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ error: "JSON invalide." });
  }
  console.error(error.message || error);
  return res.status(500).json({ error: "Erreur serveur." });
});

const port = Number(process.env.PORT || 10000);
initDb().then(() => {
  app.listen(port, "0.0.0.0", () => console.log(`GDSP API démarrée sur le port ${port}`));
}).catch(error => {
  console.error("Initialisation PostgreSQL impossible :", error);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});