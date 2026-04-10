/**
 * Aquarium Controller — Node.js/Express Backend
 *
 * Setup:
 *   npm install express ws
 *   node server.js
 *
 * Open http://localhost:3000 → Settings to configure HA connection.
 * All entity IDs are set through the UI — nothing to edit here.
 */

const express    = require("express");
const path       = require("path");
const fs         = require("fs");
const http       = require("http");
const WebSocket  = require("ws");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, ".")));

// ─── FILE HELPERS ─────────────────────────────────────────────────────────────
const CONFIG_FILE   = path.join(__dirname, "config.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");
const HISTORY_FILE  = path.join(__dirname, "history.json");

function loadConfig()   { try { return JSON.parse(fs.readFileSync(CONFIG_FILE,   "utf8")); } catch { return { host:"", port:8123, token:"" }; } }
function saveConfig(c)  { fs.writeFileSync(CONFIG_FILE,   JSON.stringify(c, null, 2)); }
function loadSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch { return {}; } }
function saveSettings(s){ fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); }
function loadHistory()  { try { return JSON.parse(fs.readFileSync(HISTORY_FILE,  "utf8")); } catch { return {}; } }
function saveHistory(h) { try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h)); } catch {} }

// ─── HA CONNECTION ────────────────────────────────────────────────────────────
const haState   = {};        // entity_id → HA state object (live cache)
let haWs        = null;
let msgId       = 1;
const pending   = {};
let haConnected = false;

function connectHA(cfg) {
  if (haWs) { haWs.removeAllListeners(); try { haWs.close(); } catch {} haWs = null; }
  haConnected = false;
  if (!cfg.host || !cfg.token) { console.log("⚠️  No HA credentials — open Settings."); return; }

  const url = `ws://${cfg.host}:${cfg.port || 8123}/api/websocket`;
  console.log(`🔌 Connecting to HA at ${cfg.host}…`);
  haWs = new WebSocket(url);

  haWs.on("open", () => console.log("✅ HA WebSocket open"));

  haWs.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "auth_required") {
      haWs.send(JSON.stringify({ type:"auth", access_token:cfg.token }));
    } else if (msg.type === "auth_ok") {
      haConnected = true;
      console.log("✅ HA authenticated");
      haWs.send(JSON.stringify({ id:msgId++, type:"subscribe_events", event_type:"state_changed" }));
      const id = msgId++;
      pending[id] = (result) => { result.forEach(e => { haState[e.entity_id] = e; }); console.log(`📦 Loaded ${result.length} entities`); };
      haWs.send(JSON.stringify({ id, type:"get_states" }));
    } else if (msg.type === "auth_invalid") {
      haConnected = false; console.error("❌ HA auth failed");
    } else if (msg.type === "event" && msg.event?.event_type === "state_changed") {
      const { entity_id, new_state } = msg.event.data;
      haState[entity_id] = new_state;
      recordHistory(entity_id, new_state?.state);
    } else if (msg.type === "result" && pending[msg.id]) {
      pending[msg.id](msg.result); delete pending[msg.id];
    }
  });

  haWs.on("close", () => { haConnected = false; console.warn("⚠️  HA closed — retrying in 10s…"); setTimeout(() => connectHA(loadConfig()), 10000); });
  haWs.on("error", (err)  => { haConnected = false; console.error("❌ HA error:", err.message); });
}

function callService(domain, service, data) {
  if (!haWs || haWs.readyState !== WebSocket.OPEN) { console.warn("HA not connected"); return; }
  haWs.send(JSON.stringify({ id:msgId++, type:"call_service", domain, service, service_data:data }));
}

// ─── SENSOR HISTORY ───────────────────────────────────────────────────────────
// Keeps last 288 readings per entity (24h at 5-min intervals)
const MAX_HISTORY = 576;  // 48h at 5-min intervals
const historyCache = loadHistory();

function recordHistory(entity_id, value) {
  const s = loadSettings();
  const sensors = s?.sensors || {};
  // Collect all tracked entity IDs (built-in primaries + secondaries + custom)
  const tracked = new Set();
  ["temperature","ph","orp","kh"].forEach(g => {
    if (sensors[g]?.primary)   tracked.add(sensors[g].primary);
    if (sensors[g]?.secondary) tracked.add(sensors[g].secondary);
  });
  Object.values(sensors?.custom || {}).forEach(c => { if (c.entity) tracked.add(c.entity); });

  if (!tracked.has(entity_id)) return;

  const num = parseFloat(value);
  if (isNaN(num)) return;

  if (!historyCache[entity_id]) historyCache[entity_id] = [];
  historyCache[entity_id].push({ t: Date.now(), v: num });
  if (historyCache[entity_id].length > MAX_HISTORY) historyCache[entity_id].shift();
}

// Persist history every 5 minutes to avoid hammering disk on every state change
setInterval(() => saveHistory(historyCache), 5 * 60 * 1000);

// ─── SERVER-SIDE AUTOMATION LOOP ──────────────────────────────────────────────
// Runs every 30s — enforces switch schedules and sensor-based automations
setInterval(() => {
  const s = loadSettings();
  const automations = s?.switchAutomation || {};

  Object.entries(automations).forEach(([id, cfg]) => {
    if (!cfg || cfg.mode === "manual") return;

    const sw = Object.values(s?.switches || {})[parseInt(id) - 1];
    if (!sw?.entity) return;

    if (cfg.mode === "schedule") {
      const now    = new Date();
      const hhmm   = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
      const onAt   = cfg.schedule?.onAt  || "00:00";
      const offAt  = cfg.schedule?.offAt || "23:59";
      const shouldBeOn = hhmm >= onAt && hhmm < offAt;
      const currentlyOn = haState[sw.entity]?.state === "on";
      if (shouldBeOn !== currentlyOn) {
        console.log(`⏰ Schedule: ${sw.entity} → ${shouldBeOn ? "ON" : "OFF"}`);
        callService("switch", shouldBeOn ? "turn_on" : "turn_off", { entity_id: sw.entity });
      }
    }

    if (cfg.mode === "sensor") {
      const sc       = cfg.sensor || {};
      const eid      = sc.entity;
      const val      = parseFloat(haState[eid]?.state);
      if (isNaN(val)) return;

      const sp       = parseFloat(sc.setpoint) || 0;
      const half     = (parseFloat(sc.variance) || 0) / 2;
      const isLow    = sc.triggerType === "low";
      const onTh     = isLow ? sp - half : sp + half;
      const offTh    = isLow ? sp + half : sp - half;
      const curOn    = haState[sw.entity]?.state === "on";
      let next       = curOn;

      if (isLow) { if (val <= onTh) next = true; if (val >= offTh) next = false; }
      else        { if (val >= onTh) next = true; if (val <= offTh) next = false; }

      if (next !== curOn) {
        console.log(`🌡️  Sensor: ${sw.entity} → ${next ? "ON" : "OFF"} (val=${val}, sp=${sp}±${half})`);
        callService("switch", next ? "turn_on" : "turn_off", { entity_id: sw.entity });
      }
    }
  });
}, 30 * 1000);

// ─── LIGHTING SCHEDULE (Corrected + Sanitized + Sydney Time) ──────────────────

// GET: merged lighting schedule with names + colors from settings.json
app.get("/api/lighting/schedule", (req, res) => {
  const s = loadSettings();
  const lighting = s?.lighting?.channels || {};
  const sched    = s?.lightingSchedule?.channels || {};

  const result = { channels: {} };

  Object.values(lighting).forEach(ch => {
    if (!ch?.entity) return;
    const eid = ch.entity;
    const existing = sched[eid] || {};

    // Build merged + sanitized schedule entry
    result.channels[eid] = {
      start_time:       existing.start_time       || "08:00",
      end_time:         existing.end_time         || "22:00",
      dim_period_hours: parseFloat(existing.dim_period_hours) || 3,
      max_brightness:   parseInt(existing.max_brightness)     || 255,
      graph_color:      existing.graph_color      || ch.color,

      // UI fields
      label:            ch.name  || "Unnamed",
      color:            ch.color || "#ffffff"
    };
  });

  res.json(result);
});


// POST: sanitize + save schedule into settings.json
app.post("/api/lighting/schedule", (req, res) => {
  const incoming = req.body?.channels || {};
  const s = loadSettings();

  if (!s.lightingSchedule) s.lightingSchedule = {};
  s.lightingSchedule.channels = {};

  Object.entries(incoming).forEach(([eid, cfg]) => {
    s.lightingSchedule.channels[eid] = {
      start_time:       cfg.start_time,
      end_time:         cfg.end_time,
      dim_period_hours: parseFloat(cfg.dim_period_hours) || 0,
      max_brightness:   parseInt(cfg.max_brightness)     || 0,
      graph_color:      cfg.graph_color || "#ffffff"
    };
  });

  saveSettings(s);
  res.json({ ok: true });
});


// ─── LIGHTING LOOP (Sydney Time + Debug Logging + Sanitized) ──────────────────
setInterval(() => {
  const s = loadSettings();
  const schedule = s?.lightingSchedule?.channels || {};

  // Convert server time → Australia/Sydney local time
  const nowSydney = new Date(
    new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" })
  );
  const minuteOfDay = nowSydney.getHours() * 60 + nowSydney.getMinutes();

  Object.entries(schedule).forEach(([entity_id, cfg]) => {
    if (!entity_id || !cfg) return;

    const brightness = computeBrightness(minuteOfDay, cfg);

    // Debug logging
    console.log(
      `LIGHT LOOP → ${entity_id} | brightness=${brightness} | time=${nowSydney.toTimeString().slice(0,5)}`
    );

    if (brightness === 0) {
      console.log(`→ HA: turn_off ${entity_id}`);
      callService("light", "turn_off", { entity_id });
    } else {
      console.log(`→ HA: turn_on ${entity_id} @ ${brightness}`);
      callService("light", "turn_on", { entity_id, brightness });
    }
  });
}, 60 * 1000);

function computeBrightness(minuteOfDay, cfg) {
  const toMin = (t) => { const [h, m] = (t||"00:00").split(":").map(Number); return h * 60 + m; };
  const start = toMin(cfg.start_time);
  const end   = toMin(cfg.end_time);
  const dim   = (cfg.dim_period_hours || 0) * 60;
  const max   = cfg.max_brightness || 255;
  if (minuteOfDay < start || minuteOfDay >= end) return 0;
  if (minuteOfDay < start + dim) return Math.round(((minuteOfDay - start) / dim) * max);
  if (minuteOfDay > end - dim)   return Math.round(((end - minuteOfDay)   / dim) * max);
  return max;
}

// ─── API: CONFIG ──────────────────────────────────────────────────────────────
app.get("/api/config", (req, res) => {
  const cfg = loadConfig();
  res.json({ host: cfg.host || "", port: cfg.port || 8123, tokenSet: !!cfg.token, connected: haConnected });
});

app.post("/api/config/save", (req, res) => {
  const { host, port, token } = req.body;
  if (!host || !token) return res.status(400).json({ error:"host and token required" });
  const cfg = { host: host.trim(), port: parseInt(port) || 8123, token: token.trim() };
  saveConfig(cfg); connectHA(cfg);
  res.json({ ok: true });
});

app.post("/api/config/test", (req, res) => {
  const { host, port, token } = req.body;
  if (!host || !token) return res.status(400).json({ error:"host and token required" });
  let done = false;
  const ws = new WebSocket(`ws://${host.trim()}:${parseInt(port)||8123}/api/websocket`);
  const timer = setTimeout(() => { if (!done) { done=true; try{ws.close();}catch{} res.json({ ok:false, error:"Timed out" }); } }, 6000);
  ws.on("message", raw => {
    const msg = JSON.parse(raw);
    if (msg.type === "auth_required") ws.send(JSON.stringify({ type:"auth", access_token:token.trim() }));
    else if (msg.type === "auth_ok")      { clearTimeout(timer); if (!done) { done=true; ws.close(); res.json({ ok:true }); } }
    else if (msg.type === "auth_invalid") { clearTimeout(timer); if (!done) { done=true; ws.close(); res.json({ ok:false, error:"Invalid token" }); } }
  });
  ws.on("error", err => { clearTimeout(timer); if (!done) { done=true; res.json({ ok:false, error:`Cannot reach ${host}: ${err.message}` }); } });
});

// ─── API: HA ENTITIES ─────────────────────────────────────────────────────────
app.get("/api/ha/entities", (req, res) => {
  if (!haConnected || Object.keys(haState).length === 0) return res.json({ connected:false, entities:{} });
  const grouped = {};
  Object.keys(haState).sort().forEach(id => {
    const domain = id.split(".")[0];
    if (!grouped[domain]) grouped[domain] = [];
    grouped[domain].push({ entity_id:id, friendly_name: haState[id]?.attributes?.friendly_name || id, state: haState[id]?.state });
  });
  res.json({ connected:true, entities:grouped });
});

// ─── API: SETTINGS ────────────────────────────────────────────────────────────
app.get("/api/settings",      (req, res) => res.json(loadSettings()));
app.post("/api/settings/save", (req, res) => {
  const incoming = req.body;
  const current  = loadSettings();

  // Merge top-level keys (lighting, switches, pumps, sensors, etc.)
	const merged = {
	  ...current,
	  ...incoming,
	  switches: {
		...current.switches,
		...incoming.switches
	  },
	  lighting: {
		...current.lighting,
		...incoming.lighting
	  },
	  lightingSchedule: {
		...current.lightingSchedule,
		...incoming.lightingSchedule
	  },
	  pumps: {
		...current.pumps,
		...incoming.pumps
	  },
	  sensors: {
		...current.sensors,
		...incoming.sensors
	  }
	};

  saveSettings(merged);
  res.json({ ok: true });
});

// ─── API: SENSORS ─────────────────────────────────────────────────────────────
// ─── API: SENSORS ─────────────────────────────────────────────────────────────
app.get("/api/sensors", (req, res) => {
  const s = loadSettings();
  const sensors = s?.sensors || {};
  const result = {};

  // Built-in sensor groups
  const groups = ["temperature","ph","orp","kh"];
  groups.forEach(group => {
    const cfg = sensors[group] || {};
    const eid = cfg.primary || null;
    result[group] = {
      value:  eid ? (haState[eid]?.state ?? null) : null,
      entity: eid,
      active: cfg.active !== false,
    };
  });

  // Legacy flat keys for backward compat — use separate keys so group objects stay intact
  result.temp = result.temperature?.value ?? null;
  result.ph_val  = result.ph?.value  ?? null;
  result.orp_val = result.orp?.value ?? null;
  result.kh_val  = result.kh?.value  ?? null;

  // Custom sensors
  const custom = sensors?.custom || {};
  result.custom = Object.entries(custom).map(([key, cfg]) => ({
    key,
    name:         cfg.name         || key,
    entity:       cfg.entity       || null,
    unit:         cfg.unit         || "none",
    customUnit:   cfg.customUnit   || "",
    showOnHome:   !!cfg.showOnHome,
    showOnSensors: cfg.showOnSensors !== false,
    value:        cfg.entity ? (haState[cfg.entity]?.state ?? null) : null,
  }));

  res.json(result);
});

// ─── HELPER: fetch HA REST API via HTTP ───────────────────────────────────────
function haGet(path) {
  return new Promise((resolve, reject) => {
    const cfg = loadConfig();
    if (!cfg.host || !cfg.token) return reject(new Error("HA not configured"));
    const options = {
      hostname: cfg.host,
      port:     cfg.port || 8123,
      path,
      method:   "GET",
      headers:  { "Authorization": `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error("Invalid JSON from HA")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("HA history request timed out")); });
    req.end();
  });
}

app.get("/api/sensors/history", async (req, res) => {
  const { entity, hours } = req.query;
  if (!entity) return res.status(400).json({ error:"entity required" });

  const h = parseInt(hours) || 8;

  // ── Try HA history API first ──────────────────────────────────────────────
  if (haConnected) {
    try {
      const start = new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
      const haPath = `/api/history/period/${start}?filter_entity_id=${encodeURIComponent(entity)}&minimal_response=true&no_attributes=true&significant_changes_only=false`;
      const haData = await haGet(haPath);

      // HA returns [ [ {state, last_changed}, ... ] ] — one array per entity
      const states = Array.isArray(haData) && haData.length > 0 ? haData[0] : [];
      const points = states
        .map(s => ({ t: new Date(s.last_changed).getTime(), v: parseFloat(s.state) }))
        .filter(p => !isNaN(p.v));

      if (points.length >= 2) {
        // Downsample to at most 300 points so the sparkline stays fast
        const result = downsample(points, 300);
        return res.json(result);
      }
    } catch(e) {
      console.warn(`HA history fetch failed for ${entity}:`, e.message);
    }
  }

  // ── Fall back to local cache ───────────────────────────────────────────────
  const data = historyCache[entity] || [];
  const points = Math.round((h / 8) * 96);
  res.json(data.slice(-points));
});

// Downsample an array of {t,v} points to at most maxPoints using LTTB-style
// bucket averaging — preserves the shape of the data better than simple slicing
function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const bucketSize = points.length / maxPoints;
  const result = [];
  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor(i * bucketSize);
    const end   = Math.min(Math.floor((i + 1) * bucketSize), points.length);
    const bucket = points.slice(start, end);
    const avgT = Math.round(bucket.reduce((s, p) => s + p.t, 0) / bucket.length);
    const avgV = bucket.reduce((s, p) => s + p.v, 0) / bucket.length;
    result.push({ t: avgT, v: parseFloat(avgV.toFixed(4)) });
  }
  return result;
}

// ─── API: SWITCHES ────────────────────────────────────────────────────────────
app.get("/api/switches", (req, res) => {
  const s = loadSettings();
  const switches = s?.switches || {};
  const result = Object.entries(switches).map(([key, cfg], i) => ({
    id: i + 1, key, name: cfg.name || key, entity: cfg.entity,
    state: haState[cfg.entity]?.state ?? "unknown",
    power: haState[cfg.entity]?.attributes?.current_power_w ?? null,
    watts: cfg.watts || 0,
    icon:  cfg.icon  || "⏻",
  }));
  res.json(result);
});

app.post("/api/switches/toggle", (req, res) => {
  const { switch: id, state: on } = req.query;
  const s = loadSettings();
  const sw = Object.values(s?.switches || {})[parseInt(id) - 1];
  if (!sw?.entity) return res.status(400).json({ error:"Switch not configured" });
  callService("switch", on === "on" ? "turn_on" : "turn_off", { entity_id: sw.entity });
  res.json({ ok:true });
});

app.post("/api/switches/config", (req, res) => {
  const { id, config } = req.body;
  const s = loadSettings();
  if (!s.switchAutomation) s.switchAutomation = {};
  s.switchAutomation[id] = config;
  saveSettings(s);
  res.json({ ok:true });
});

// ─── API: DOSING ──────────────────────────────────────────────────────────────

// Helper: read an input_number value from HA state cache
function getInputNumber(entity) {
  if (!entity) return null;
  const val = parseFloat(haState[entity]?.state);
  return isNaN(val) ? null : val;
}

// Helper: set an input_number value via HA service call
function setInputNumber(entity, value) {
  if (!entity) return;
  callService("input_number", "set_value", { entity_id: entity, value });
}

// Helper: set an input_boolean via HA service call
function setInputBoolean(entity, on) {
  if (!entity) return;
  callService("input_boolean", on ? "turn_on" : "turn_off", { entity_id: entity });
}

// GET /api/dosing — returns pump list with live HA values for volume & calibration multiplier
app.get("/api/dosing", (req, res) => {
  const s = loadSettings();
  const pumps  = s?.dosing?.pumps  || {};
  const result = Object.entries(pumps).map(([key, cfg], i) => {
    const idx = i + 1;
    const multiplierEntity = cfg.calibrationEntity || null;
    const volumeEntity     = cfg.volumeEntity      || null;
    const triggerEntity    = cfg.triggerEntity     || null;

    // Live values from HA (fall back to 0)
    const multiplier = getInputNumber(multiplierEntity) ?? 0;
    const volume     = getInputNumber(volumeEntity)     ?? 0;
    const triggerState = triggerEntity ? (haState[triggerEntity]?.state ?? "off") : "off";

    return {
      id: idx, key,
      name:              cfg.name   || `Pump ${idx}`,
      entity:            cfg.entity || null,          // switch entity (for manual toggle)
      triggerEntity,                                  // input_boolean — starts HA automation
      calibrationEntity: multiplierEntity,
      volumeEntity,
      multiplier,   // seconds per mL (1 / mlPerSec)
      volume,       // mL per dose (from HA input_number)
      triggerState, // current state of the trigger boolean
      switchState:  haState[cfg.entity]?.state ?? "off",
      schedule:     s?.dosing?.schedule?.[idx] || null,
    };
  });
  res.json(result);
});

// POST /api/dosing/toggle?pump=1&state=on  — manual pump toggle (switch entity)
app.post("/api/dosing/toggle", (req, res) => {
  const { pump, state: on } = req.query;
  const s = loadSettings();
  const pumps = Object.values(s?.dosing?.pumps || {});
  const p = pumps[parseInt(pump) - 1];
  if (!p?.entity) return res.status(400).json({ error:"Pump switch not configured" });
  callService("switch", on === "on" ? "turn_on" : "turn_off", { entity_id: p.entity });
  res.json({ ok:true });
});

// POST /api/dosing/dose?pump=1  — trigger one dose via input_boolean
app.post("/api/dosing/dose", (req, res) => {
  const { pump } = req.query;
  const s = loadSettings();
  const pumps = Object.values(s?.dosing?.pumps || {});
  const p = pumps[parseInt(pump) - 1];
  if (!p?.triggerEntity) return res.status(400).json({ error:"Trigger boolean not configured" });
  setInputBoolean(p.triggerEntity, true);
  res.json({ ok:true });
});

// POST /api/dosing/setVolume?pump=1&ml=5  — write dose volume back to HA input_number
app.post("/api/dosing/setVolume", (req, res) => {
  const { pump, ml } = req.query;
  const s = loadSettings();
  const pumps = Object.values(s?.dosing?.pumps || {});
  const p = pumps[parseInt(pump) - 1];
  if (p?.volumeEntity) {
    setInputNumber(p.volumeEntity, parseFloat(ml));
  } else {
    // Fallback: store locally
    if (!s.dosing) s.dosing = {};
    if (!s.dosing.volumes) s.dosing.volumes = {};
    s.dosing.volumes[pump] = parseFloat(ml);
    saveSettings(s);
  }
  res.json({ ok:true });
});

// POST /api/dosing/calibrate?pump=1&multiplier=1.0204  — save pre-computed multiplier to HA
// Formula computed client-side: newMultiplier = (10 / measuredMl) * currentMultiplier
app.post("/api/dosing/calibrate", (req, res) => {
  const { pump, multiplier } = req.query;
  const mult     = parseFloat(multiplier);
  const mlPerSec = 1 / mult;

  const s = loadSettings();
  const pumps = Object.values(s?.dosing?.pumps || {});
  const p = pumps[parseInt(pump) - 1];

  if (p?.calibrationEntity) {
    setInputNumber(p.calibrationEntity, parseFloat(mult.toFixed(6)));
  }

  if (!s.dosing) s.dosing = {};
  if (!s.dosing.calibration) s.dosing.calibration = {};
  s.dosing.calibration[pump] = { mlPerSec, multiplier: mult, calibratedAt: Date.now() };
  saveSettings(s);

  res.json({ ok:true, mlPerSec, multiplier: mult });
});

// POST /api/dosing/calDose?pump=1  — run a calibration dose of 10 mL via the trigger boolean
// Uses the pump's current calibration multiplier × 10 to determine duration, then fires trigger
app.post("/api/dosing/calDose", (req, res) => {
  const { pump } = req.query;
  const s = loadSettings();
  const pumps = Object.values(s?.dosing?.pumps || {});
  const p = pumps[parseInt(pump) - 1];
  if (!p) return res.status(400).json({ error:"Pump not configured" });

  // Get current multiplier from HA state or local fallback
  const multiplier = getInputNumber(p?.calibrationEntity)
    ?? s?.dosing?.calibration?.[pump]?.multiplier
    ?? 1;
  const durationMs = Math.round(multiplier * 10 * 1000); // 10 mL × sec/mL → ms

  // Directly toggle the switch entity for calibration (bypass the HA automation
  // which uses the dose-volume input_number — we want exactly 10 mL here)
  if (p.entity) {
    callService("switch", "turn_on", { entity_id: p.entity });
    setTimeout(() => callService("switch", "turn_off", { entity_id: p.entity }), durationMs);
  } else if (p.triggerEntity) {
    // Fallback: fire trigger boolean
    setInputBoolean(p.triggerEntity, true);
  }

  res.json({ ok:true, durationMs, multiplier });
});

// POST /api/dosing/schedule  — save per-pump dosing schedules
app.post("/api/dosing/schedule", (req, res) => {
  const { pump, schedule } = req.body;
  const s = loadSettings();
  if (!s.dosing) s.dosing = {};
  if (!s.dosing.schedule) s.dosing.schedule = {};
  s.dosing.schedule[pump] = schedule;
  saveSettings(s);
  res.json({ ok:true });
});

// ─── DOSING AUTOMATION LOOP ────────────────────────────────────────────────
// Checks every 30s whether any pump is due for a scheduled dose
setInterval(() => {
  const s = loadSettings();
  const pumps    = s?.dosing?.pumps    || {};
  const schedule = s?.dosing?.schedule || {};

  const nowSyd = new Date(new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" }));
  const hh = nowSyd.getHours();
  const mm = nowSyd.getMinutes();
  const totalMin = hh * 60 + mm;

  Object.entries(pumps).forEach(([key, cfg], i) => {
    const idx  = i + 1;
    const sched = schedule[idx];
    if (!sched || !sched.enabled) return;
    if (!cfg.triggerEntity) return;

    // Time window check (skip if outside start/end and not "all hours")
    if (!sched.allHours) {
      const toMin = t => { const [h, m] = (t||"00:00").split(":").map(Number); return h * 60 + m; };
      if (totalMin < toMin(sched.startTime) || totalMin >= toMin(sched.endTime)) return;
    }

    // Interval check — convert to minutes
    const intervalMin = sched.intervalUnit === "hours"
      ? (parseFloat(sched.interval) || 1) * 60
      : (parseFloat(sched.interval) || 60);

    const offset = parseInt(sched.offsetMinutes) || 0;

    // Fire if (current minute - offset) is exactly divisible by interval
    const adjusted = totalMin - offset;
    if (adjusted < 0) return; // offset not yet reached in day
    if (adjusted % Math.round(intervalMin) !== 0) return;

    // Avoid double-firing within same minute (track last fired)
    const lastFiredKey = `doseLastFired_${idx}`;
    if (s._dosingFired?.[lastFiredKey] === totalMin) return;
    if (!s._dosingFired) s._dosingFired = {};
    s._dosingFired[lastFiredKey] = totalMin;
    saveSettings(s);

    console.log(`💉 Dosing pump ${idx} (${cfg.name || key}) — triggering via ${cfg.triggerEntity}`);
    setInputBoolean(cfg.triggerEntity, true);
  });
}, 30 * 1000);

// ─── API: PUMPS ───────────────────────────────────────────────────────────────
app.get("/api/pumps", (req, res) => {
  const s = loadSettings();
  const pumps = s?.pumps || {};
  const result = Object.entries(pumps).map(([key, cfg], i) => ({
    id:         i + 1,
    key,
    name:       cfg.name   || key,
    entity:     cfg.entity || null,
    state:      haState[cfg.entity]?.state ?? "unknown",
    modeConfig: cfg.modeConfig || { mode: "constant", speed: 75 },
    liveSpeed:  pumpLiveSpeed[i + 1] ?? null,
  }));
  res.json(result);
});

app.post("/api/pumps/toggle", (req, res) => {
  const { pump, state: on } = req.query;
  const s = loadSettings();
  const p = Object.values(s?.pumps || {})[parseInt(pump) - 1];
  if (!p?.entity) return res.status(400).json({ error:"Pump not configured" });
  callService("switch", on === "on" ? "turn_on" : "turn_off", { entity_id: p.entity });
  res.json({ ok:true });
});

// POST /api/pumps/mode  body: { pump: id, config: { mode, ...params } }
app.post("/api/pumps/mode", (req, res) => {
  const { pump, config } = req.body;
  const s = loadSettings();
  const keys = Object.keys(s?.pumps || {});
  const key  = keys[parseInt(pump) - 1];
  if (!key) return res.status(400).json({ error:"Pump not found" });
  s.pumps[key].modeConfig = config;
  saveSettings(s);
  res.json({ ok:true });
});

// ─── SERVER-SIDE PUMP MODE LOOP ───────────────────────────────────────────────
// Runs every 2 seconds — computes target speed for each pump based on its mode
// and sends fan.set_percentage to HA.
const pumpLiveSpeed = {};   // pump id → current speed %
const pumpLoopState = {};   // pump id → internal state for wave/pulse/random

setInterval(() => {
  const s = loadSettings();
  const pumps = s?.pumps || {};
  const now = Date.now() / 1000; // seconds

  Object.entries(pumps).forEach(([key, cfg], i) => {
    const id = i + 1;
    if (!cfg?.entity) return;

    // Only run loop if pump is on
    if (haState[cfg.entity]?.state !== "on") {
      pumpLiveSpeed[id] = 0;
      return;
    }

    const mc = cfg.modeConfig || { mode: "constant", speed: 75 };
    let target = 0;

    if (mc.mode === "constant") {
      target = mc.speed ?? 75;

    } else if (mc.mode === "wave") {
      const min    = mc.minFlow ?? 30;
      const max    = mc.maxFlow ?? 100;
      const period = mc.period  ?? 60;
      // Sine wave: 0 = min, peak = max
      const phase  = (now % period) / period; // 0..1
      const sine   = (Math.sin(phase * 2 * Math.PI - Math.PI / 2) + 1) / 2; // 0..1
      target = Math.round(min + sine * (max - min));

    } else if (mc.mode === "pulse") {
      const min         = mc.minFlow     ?? 20;
      const max         = mc.maxFlow     ?? 100;
      const pulseLength = mc.pulseLength ?? 1.0;
      const delay       = mc.delay       ?? 2.0;
      const cycle       = pulseLength + delay;
      const phase       = now % cycle;
      target = phase < pulseLength ? max : min;

    } else if (mc.mode === "random") {
      // Random walk — step size depends on changeRate
      const min  = mc.minFlow    ?? 20;
      const max  = mc.maxFlow    ?? 100;
      const rate = mc.changeRate ?? "medium";
      const step = rate === "slow" ? 2 : rate === "fast" ? 10 : 5;

      const prev = pumpLiveSpeed[id] ?? Math.round((min + max) / 2);
      const delta = (Math.random() * step * 2) - step; // -step..+step
      target = Math.round(Math.min(max, Math.max(min, prev + delta)));
    }

    // Only send if speed changed by ≥1% to avoid hammering HA
    if (target !== pumpLiveSpeed[id]) {
      pumpLiveSpeed[id] = target;
      callService("fan", "set_percentage", { entity_id: cfg.entity, percentage: target });
    }
  });
}, 2000);

// ─── API: LIGHTING SCHEDULE (backed by settings.json) ────────────────────────

// GET: merged lighting schedule with names + colors from settings.json
app.get("/api/lighting/schedule", (req, res) => {
  const s = loadSettings();
  const lighting = s?.lighting?.channels || {};
  const sched    = s?.lightingSchedule?.channels || {};

  const result = { channels: {} };

  Object.values(lighting).forEach(ch => {
    if (!ch?.entity) return;
    const eid = ch.entity;
    const existing = sched[eid] || {};

    result.channels[eid] = {
      // schedule values
      start_time:       existing.start_time       || "08:00",
      end_time:         existing.end_time         || "22:00",
      dim_period_hours: existing.dim_period_hours || 3,
      max_brightness:   existing.max_brightness   || 255,
      graph_color:      existing.graph_color      || ch.color,

      // NEW: name for UI
      label:            ch.name || "Unnamed",

      // NEW: color for UI
      color:            ch.color || "#ffffff"
    };
  });

  res.json(result);
});

// POST: body = { channels: { entity_id: cfg } } → store under settings.lightingSchedule.channels
app.post("/api/lighting/schedule", (req, res) => {
  const incoming = req.body?.channels || {};
  const s = loadSettings();
  if (!s.lightingSchedule) s.lightingSchedule = {};
  s.lightingSchedule.channels = {};

  Object.entries(incoming).forEach(([eid, cfg]) => {
    s.lightingSchedule.channels[eid] = {
      start_time: cfg.start_time,
      end_time: cfg.end_time,
      dim_period_hours: parseFloat(cfg.dim_period_hours) || 0,
      max_brightness: parseInt(cfg.max_brightness) || 0,
      graph_color: cfg.graph_color || "#ffffff"
    };
  });

  saveSettings(s);
  res.json({ ok: true });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🐠 Aquarium Controller → http://localhost:${PORT}`);
  const cfg = loadConfig();
  if (cfg.host && cfg.token) connectHA(cfg);
  else console.log("💡 Open Settings to configure HA connection.");
});
