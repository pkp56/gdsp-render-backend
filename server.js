const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));

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
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /neon\.tech|render\.com/i.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined
});

// ---------- DB init ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gdsp_events (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('championship','open','archive')),
      points_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gdsp_events_kind ON gdsp_events(kind)`);

  // Legacy table may exist (single-row v1 schema). If it has data, migrate it to a default event.
  const legacy = await pool.query(`
    SELECT to_regclass('public.gdsp_championship_data') AS tbl
  `);
  if (legacy.rows[0]?.tbl) {
    const { rows } = await pool.query("SELECT championship FROM gdsp_championship_data WHERE id = 1");
    const legacyData = rows[0]?.championship;
    if (legacyData && typeof legacyData === "object" && Object.keys(legacyData).length > 0) {
      const { rowCount } = await pool.query(
        `INSERT INTO gdsp_events (slug, name, kind, points_config, data, updated_by)
         VALUES ($1,$2,'championship',$3::jsonb,$4::jsonb,'migration')
         ON CONFLICT (slug) DO NOTHING`,
        [
          "lola-t290-2026",
          "International Series Lola T290 — 2026",
          JSON.stringify({
            // Default Lola T290 2026 barème
            pointsScale: [41,38,35,32,30,28,26,24,22,20,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1],
            polePoints: 1,
            doubleLongRaces: true,  // manches d'1h = points doublés
            longRaceMinutes: 60,
            minPercentDistance: 0.75,
            jokerCount: 5,
            globalCoef: 1.0
          }),
          JSON.stringify(legacyData)
        ]
      );
      if (rowCount > 0) console.log("Migré l'ancien championnat vers l'event 'lola-t290-2026'.");
    }
  }
}

// ---------- Auth ----------
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

function isNonEmptyObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function validSlug(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,60}$/.test(s);
}

// ---------- Public routes ----------
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "gdsp-api", database: "connected" });
  } catch {
    res.status(503).json({ ok: false, database: "unavailable" });
  }
});

app.post("/api/admin/login", async (req, res) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  // Identifiants par défaut de premier secours si les variables d'env ne sont pas configurées.
  // À REMPLACER en définissant ADMIN_USERNAME / ADMIN_PASSWORD dans Render, puis redéployer.
  const DEFAULT_USER = "gdspadmin";
  const DEFAULT_PASS = "gdsp290";
  const expectedUser = process.env.ADMIN_USERNAME || DEFAULT_USER;
  const expectedPassword = process.env.ADMIN_PASSWORD || DEFAULT_PASS;
  const validUser = username === expectedUser;
  const isHash = typeof expectedPassword === 'string' && expectedPassword.startsWith("$2");
  const validPassword = isHash
    ? await bcrypt.compare(password, expectedPassword)
    : password === expectedPassword;
  if (!validUser || !validPassword) {
    return res.status(401).json({ error: "Identifiant ou mot de passe incorrect." });
  }
  const token = jwt.sign({ sub: expectedUser, role: "admin" }, process.env.JWT_SECRET||"dev-jwt-secret-change-me", { expiresIn: "8h" });
  return res.json({ token, expiresIn: 28800 });
});

// Backwards-compat alias (same handler as /api/admin/login)
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

// List all events (for the hub)
app.get("/api/events", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT slug, name, kind, points_config, updated_at
       FROM gdsp_events
       ORDER BY kind = 'championship' DESC, kind = 'open' DESC, updated_at DESC`
    );
    res.json({ events: rows });
  } catch (e) {
    console.error("GET events:", e.message);
    res.status(500).json({ error: "Impossible de lister les événements." });
  }
});

// Get one event's full data
app.get("/api/events/:slug", async (req, res) => {
  if (!validSlug(req.params.slug)) return res.status(400).json({ error: "Slug invalide." });
  try {
    const { rows } = await pool.query(
      `SELECT slug, name, kind, points_config, data, updated_at FROM gdsp_events WHERE slug = $1`,
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ error: "Événement introuvable." });
    res.json(rows[0]);
  } catch (e) {
    console.error("GET event:", e.message);
    res.status(500).json({ error: "Impossible de lire l'événement." });
  }
});

// ---------- Admin routes ----------
app.post("/api/events", requireAuth, async (req, res) => {
  const slug = String(req.body?.slug || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim();
  const kind = String(req.body?.kind || "championship");
  if (!validSlug(slug)) return res.status(400).json({ error: "Identifiant (slug) invalide. Utilisez lettres, chiffres et tirets." });
  if (!name || name.length > 120) return res.status(400).json({ error: "Nom manquant ou trop long." });
  if (!["championship", "open", "archive"].includes(kind)) return res.status(400).json({ error: "Type invalide." });

  const defaultConfig = {
    pointsScale: [41,38,35,32,30,28,26,24,22,20,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1],
    polePoints: 1,
    doubleLongRaces: false,
    longRaceMinutes: 60,
    minPercentDistance: 0.75,
    jokerCount: 0,
    globalCoef: kind === "open" ? 0.5 : 1.0
  };
  const pointsConfig = { ...defaultConfig, ...(req.body?.pointsConfig || {}) };
  const initData = (req.body?.data && typeof req.body.data === 'object') ? req.body.data : {};

  try {
    const { rows } = await pool.query(
      `INSERT INTO gdsp_events (slug, name, kind, points_config, data, updated_by)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug, name, kind`,
      [slug, name, kind, JSON.stringify(pointsConfig), JSON.stringify(initData), req.admin.sub]
    );
    if (!rows.length) return res.status(409).json({ error: "Un événement avec cet identifiant existe déjà." });
    res.json({ status: "ok", event: rows[0] });
  } catch (e) {
    console.error("POST event:", e.message);
    res.status(500).json({ error: "Impossible de créer l'événement." });
  }
});

app.delete("/api/events/:slug", requireAuth, async (req, res) => {
  if (!validSlug(req.params.slug)) return res.status(400).json({ error: "Slug invalide." });
  try {
    const { rowCount } = await pool.query(`DELETE FROM gdsp_events WHERE slug = $1`, [req.params.slug]);
    if (!rowCount) return res.status(404).json({ error: "Événement introuvable." });
    res.json({ status: "ok" });
  } catch (e) {
    console.error("DELETE event:", e.message);
    res.status(500).json({ error: "Impossible de supprimer l'événement." });
  }
});

// Update event metadata (name/kind/points config)
app.put("/api/events/:slug", requireAuth, async (req, res) => {
  if (!validSlug(req.params.slug)) return res.status(400).json({ error: "Slug invalide." });
  const fields = [];
  const values = [req.params.slug];
  let i = 2;
  if (typeof req.body?.name === "string") {
    const name = req.body.name.trim();
    if (!name || name.length > 120) return res.status(400).json({ error: "Nom invalide." });
    fields.push(`name = $${i++}`);
    values.push(name);
  }
  if (typeof req.body?.kind === "string") {
    if (!["championship", "open", "archive"].includes(req.body.kind))
      return res.status(400).json({ error: "Type invalide." });
    fields.push(`kind = $${i++}`);
    values.push(req.body.kind);
  }
  if (req.body?.pointsConfig && typeof req.body.pointsConfig === "object") {
    fields.push(`points_config = $${i++}::jsonb`);
    values.push(JSON.stringify(req.body.pointsConfig));
  }
  if (isNonEmptyObject(req.body?.data)) {
    fields.push(`data = $${i++}::jsonb`);
    values.push(JSON.stringify(req.body.data));
  }
  if (!fields.length) return res.status(400).json({ error: "Rien à mettre à jour." });
  fields.push(`updated_at = NOW()`, `updated_by = $${i++}`);
  values.push(req.admin.sub);
  try {
    const { rows } = await pool.query(
      `UPDATE gdsp_events SET ${fields.join(", ")} WHERE slug = $1
       RETURNING slug, name, kind, points_config, updated_at`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: "Événement introuvable." });
    res.json({ status: "ok", event: rows[0] });
  } catch (e) {
    console.error("PUT event:", e.message);
    res.status(500).json({ error: "Impossible de mettre à jour l'événement." });
  }
});

// Save the full championship data (sessions/penMap/...) for an event
// Alias: POST /api/events/:slug/data (also keeps POST /api/save-championship for legacy, pointing to lola-t290-2026)
app.post("/api/events/:slug/data", requireAuth, async (req, res) => {
  if (!validSlug(req.params.slug)) return res.status(400).json({ error: "Slug invalide." });
  if (!isNonEmptyObject(req.body)) return res.status(400).json({ error: "Données invalides." });
  try {
    const { rows } = await pool.query(
      `UPDATE gdsp_events SET data = $2::jsonb, updated_at = NOW(), updated_by = $3
       WHERE slug = $1
       RETURNING updated_at`,
      [req.params.slug, JSON.stringify(req.body), req.admin.sub]
    );
    if (!rows.length) return res.status(404).json({ error: "Événement introuvable." });
    res.json({ status: "ok", updatedAt: rows[0].updated_at });
  } catch (e) {
    console.error("POST event data:", e.message);
    res.status(500).json({ error: "Impossible d'enregistrer les données." });
  }
});

// Legacy endpoints: map to the default lola-t290-2026 event so older front builds keep working.
app.get("/api/championship", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT data AS championship, updated_at, points_config FROM gdsp_events WHERE slug = 'lola-t290-2026'`
    );
    res.json({
      championship: rows[0]?.championship || {},
      pointsConfig: rows[0]?.points_config || null,
      updatedAt: rows[0]?.updated_at || null
    });
  } catch (e) {
    res.status(500).json({ error: "Impossible de lire le championnat." });
  }
});

app.post("/api/save-championship", requireAuth, async (req, res) => {
  if (!isNonEmptyObject(req.body)) return res.status(400).json({ error: "Championnat JSON invalide." });
  try {
    const { rows } = await pool.query(
      `INSERT INTO gdsp_events (slug, name, kind, data, points_config, updated_by)
       VALUES ('lola-t290-2026','International Series Lola T290 — 2026','championship',$1::jsonb,$2::jsonb,$3)
       ON CONFLICT (slug) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW(), updated_by = EXCLUDED.updated_by
       RETURNING updated_at`,
      [
        JSON.stringify(req.body),
        JSON.stringify({
          pointsScale: [41,38,35,32,30,28,26,24,22,20,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1],
          polePoints: 1, doubleLongRaces: true, longRaceMinutes: 60,
          minPercentDistance: 0.75, jokerCount: 5, globalCoef: 1.0
        }),
        req.admin.sub
      ]
    );
    res.json({ status: "ok", message: "Championnat enregistré.", updatedAt: rows[0].updated_at });
  } catch (e) {
    console.error("legacy save:", e.message);
    res.status(500).json({ error: "Impossible d'enregistrer." });
  }
});

// ---------- Error handlers ----------
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
