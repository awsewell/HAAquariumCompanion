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
      pending[msg.id](msg.result, msg.success, msg.error); delete pending[msg.id];
    }
  });

  haWs.on("close", () => { haConnected = false; console.warn("⚠️  HA closed — retrying in 10s…"); setTimeout(() => connectHA(loadConfig()), 10000); });
  haWs.on("error", (err)  => { haConnected = false; console.error("❌ HA error:", err.message); });
}

function callService(domain, service, data) {
  if (!haWs || haWs.readyState !== WebSocket.OPEN) { console.warn("HA not connected"); return; }
  haWs.send(JSON.stringify({ id:msgId++, type:"call_service", domain, service, service_data:data }));
}
// Send a WebSocket message and return a Promise that resolves with the result.
// Rejects if HA returns success:false, or after timeoutMs with no response.
function callWs(msg, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!haWs || haWs.readyState !== WebSocket.OPEN) {
      return reject(new Error('HA WebSocket not connected'));
    }
    const id = msgId++;
    const timer = setTimeout(() => {
      delete pending[id];
      reject(new Error('WebSocket timeout waiting for id ' + id));
    }, timeoutMs);
    pending[id] = (result, success, error) => {
      clearTimeout(timer);
      if (success === false) {
        reject(new Error((error && error.message) || JSON.stringify(error) || 'HA returned error'));
      } else {
        resolve(result);
      }
    };
    haWs.send(JSON.stringify(Object.assign({}, msg, { id })));
  });
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


// ─── LIGHTING LOOP (Sydney Time + Debug Logging + Sanitized) ──────────────────
setInterval(() => {
  const s = loadSettings();
  const schedule = s?.lightingSchedule?.channels || {};

  // Convert server time → Australia/Sydney local time
  const nowSydney = new Date();
  const sydneyTime = new Date(
    nowSydney.toLocaleString("en-US", { timeZone: "Australia/Sydney" })
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
  try {
    const incoming = req.body || {};
    const current  = loadSettings();

    // Helper — safe spread that tolerates undefined/null values
    const s = (a, b) => ({ ...(a || {}), ...(b || {}) });

    const merged = {
      ...current,
      ...incoming,
      switches:        s(current.switches,        incoming.switches),
      lighting:        s(current.lighting,        incoming.lighting),
      lightingSchedule:s(current.lightingSchedule,incoming.lightingSchedule),
      pumps:           s(current.pumps,           incoming.pumps),
      sensors:         s(current.sensors,         incoming.sensors),
      levelSensors:    s(current.levelSensors,    incoming.levelSensors),
    };

    saveSettings(merged);
    res.json({ ok: true });
  } catch (err) {
    console.error("Settings save error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: SWITCH AUTOMATION SAVE ─────────────────────────────────────────────
app.post("/api/switches/automation/save", async (req, res) => {
  try {
    const { id, name, entity, config } = req.body;
    if (!id || !name || !entity) {
      return res.status(400).json({ ok:false, error:"Missing id/name/entity" });
    }

    // Save automation config into settings.json
    const s = loadSettings();
    if (!s.switchAutomation) s.switchAutomation = {};
    s.switchAutomation[id] = config;
    saveSettings(s);

    // Push to Home Assistant
    await pushAutomationsToHA(name, entity, config);

    res.json({ ok:true });
  } catch (err) {
    console.error("Automation save error:", err);
    res.status(500).json({ ok:false, error:err.message });
  }
});

// ─── API: SENSORS ─────────────────────────────────────────────────────────────
app.get("/api/sensors", (req, res) => {
  const s = loadSettings();
  const sensors = s?.sensors || {};
  const result = {};

  // Built-in sensor groups
  const groups = ["temperature","ph","orp","kh"];
  groups.forEach(group => {
    const cfg  = sensors[group] || {};
    const eid  = cfg.primary   || null;
    const eid2 = cfg.secondary || null;
    result[group] = {
      value:          eid  ? (haState[eid]?.state  ?? null) : null,
      secondaryValue: eid2 ? (haState[eid2]?.state ?? null) : null,
      entity:         eid,
      secondaryEntity: eid2,
      active:         cfg.active !== false,
      decimals:       cfg.decimals ?? null,
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
    decimals:     cfg.decimals ?? null,
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


// ─── HA REST API HELPERS (POST / DELETE) ──────────────────────────────────────
function haRest(method, path, body) {
  return new Promise((resolve, reject) => {
    const cfg = loadConfig();
    if (!cfg.host || !cfg.token) return reject(new Error("HA not configured"));
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: cfg.host,
      port:     cfg.port || 8123,
      path,
      method,
      headers: {
        "Authorization":  `Bearer ${cfg.token}`,
        "Content-Type":   "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        // Some HA endpoints return empty body on success
        if (!data.trim()) return resolve({ ok: true, status: res.statusCode });
        try { resolve({ ok: res.statusCode < 300, status: res.statusCode, ...JSON.parse(data) }); }
        catch { resolve({ ok: res.statusCode < 300, status: res.statusCode, raw: data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("HA REST request timed out")); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── HA HELPER & AUTOMATION UTILITIES ─────────────────────────────────────────

// Convert a friendly name to a slug: "Return Pump" → "return_pump"
function nameToSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// Derive all helper entity IDs for a switch from its name
function switchHelperIds(name) {
  const s = nameToSlug(name);
  return {
    mode:           `input_text.aquarium_${s}_mode`,
    scheduleOn:     `input_text.aquarium_${s}_schedule_on`,
    scheduleOff:    `input_text.aquarium_${s}_schedule_off`,
    sensorEntity:   `input_text.aquarium_${s}_sensor_entity`,
    triggerType:    `input_text.aquarium_${s}_trigger_type`,
    onThreshold:    `input_number.aquarium_${s}_on_threshold`,
    offThreshold:   `input_number.aquarium_${s}_off_threshold`,
    levelEntity1:   `input_text.aquarium_${s}_level_entity1`,
    levelEntity2:   `input_text.aquarium_${s}_level_entity2`,
  };
}

// Check whether the mode helper exists in HA (fast existence check)
async function switchHelpersExist(name) {
  try {
    const h = switchHelperIds(name);
    const result = await haRest("GET", `/api/states/${h.mode}`);
    return result.status !== 404;
  } catch { return false; }
}

// Create all 9 helpers for a switch in HA via WebSocket (Storage Collection API).
// input_text and input_number are storage-based helpers — the correct API is
// WebSocket commands "input_text/create" and "input_number/create", NOT REST.
// HA auto-generates the entity ID on create, so we immediately rename it to the
// slug we want using config/entity_registry/update.
async function createSwitchHelpers(name) {
  const slug   = nameToSlug(name);
  const label  = name;
  const errors = [];
  const created = [];

  // input_text helpers
  const textHelpers = [
    { id: `aquarium_${slug}_mode`,          name: `Aquarium ${label} Mode`,           initial: "manual", min: 0, max: 255 },
    { id: `aquarium_${slug}_schedule_on`,   name: `Aquarium ${label} Schedule On`,    initial: "08:00",  min: 0, max: 10  },
    { id: `aquarium_${slug}_schedule_off`,  name: `Aquarium ${label} Schedule Off`,   initial: "22:00",  min: 0, max: 10  },
    { id: `aquarium_${slug}_sensor_entity`, name: `Aquarium ${label} Sensor Entity`,  initial: "",       min: 0, max: 255 },
    { id: `aquarium_${slug}_trigger_type`,  name: `Aquarium ${label} Trigger Type`,   initial: "low",    min: 0, max: 10  },
    { id: `aquarium_${slug}_level_entity1`, name: `Aquarium ${label} Level Entity 1`, initial: "",       min: 0, max: 255 },
    { id: `aquarium_${slug}_level_entity2`, name: `Aquarium ${label} Level Entity 2`, initial: "",       min: 0, max: 255 },
  ];

  for (const h of textHelpers) {
    const targetEntityId = `input_text.${h.id}`;
    try {
      // Create the helper — HA returns the new item object with its auto-assigned id
      const result = await callWs({ type: "input_text/create", name: h.name, initial: h.initial, min: h.min, max: h.max });
      const autoEntityId = `input_text.${result.id}`;
      // Rename to the deterministic slug-based entity ID we need
      if (autoEntityId !== targetEntityId) {
        await callWs({ type: "config/entity_registry/update", entity_id: autoEntityId, new_entity_id: targetEntityId });
      }
      created.push(targetEntityId);
    } catch(e) {
      console.error(`Helper creation error (${targetEntityId}): ${e.message}`);
      errors.push(`${targetEntityId}: ${e.message}`);
    }
  }

  // input_number helpers
  const numberHelpers = [
    { id: `aquarium_${slug}_on_threshold`,  name: `Aquarium ${label} On Threshold`,  initial: 25, min: -9999, max: 9999, step: 0.1 },
    { id: `aquarium_${slug}_off_threshold`, name: `Aquarium ${label} Off Threshold`, initial: 26, min: -9999, max: 9999, step: 0.1 },
  ];

  for (const h of numberHelpers) {
    const targetEntityId = `input_number.${h.id}`;
    try {
      const result = await callWs({ type: "input_number/create", name: h.name, initial: h.initial, min: h.min, max: h.max, step: h.step, mode: "box" });
      const autoEntityId = `input_number.${result.id}`;
      if (autoEntityId !== targetEntityId) {
        await callWs({ type: "config/entity_registry/update", entity_id: autoEntityId, new_entity_id: targetEntityId });
      }
      created.push(targetEntityId);
    } catch(e) {
      console.error(`Helper creation error (${targetEntityId}): ${e.message}`);
      errors.push(`${targetEntityId}: ${e.message}`);
    }
  }

  console.log(`🔧 Helpers created for "${name}": ${created.length} OK, ${errors.length} errors`);
  if (errors.length) console.warn("  Errors:", errors);

  return { ok: true, created, errors };
}

// Write current swState values into the HA helpers via service calls
async function syncHelpersFromState(name, switchEntity, automationCfg) {
  const h   = switchHelperIds(name);
  const cfg = automationCfg || {};
  const mode = cfg.mode || "manual";
  const sc   = cfg.schedule    || {};
  const sen  = cfg.sensor      || {};
  const lev  = cfg.levelSensor || {};

  // Compute on/off thresholds from setpoint + variance
  const sp    = parseFloat(sen.setpoint) || 0;
  const half  = (parseFloat(sen.variance) || 0) / 2;
  const isLow = (sen.triggerType || "low") === "low";
  const onTh  = isLow ? sp - half : sp + half;
  const offTh = isLow ? sp + half : sp - half;

  const textUpdates = [
    { entity_id: h.mode,         value: mode },
    { entity_id: h.scheduleOn,   value: sc.onAt   || "08:00" },
    { entity_id: h.scheduleOff,  value: sc.offAt  || "22:00" },
    { entity_id: h.sensorEntity, value: sen.entity || "" },
    { entity_id: h.triggerType,  value: sen.triggerType || "low" },
    { entity_id: h.levelEntity1, value: lev.entity1 || "" },
    { entity_id: h.levelEntity2, value: lev.entity2 || "" },
  ];

  const numUpdates = [
    { entity_id: h.onThreshold,  value: onTh },
    { entity_id: h.offThreshold, value: offTh },
  ];

  for (const u of textUpdates) {
    try { await haRest("POST", "/api/services/input_text/set_value", u); } catch {}
  }
  for (const u of numUpdates) {
    try { await haRest("POST", "/api/services/input_number/set_value", u); } catch {}
  }
}

// ─── API: SWITCH HELPER STATUS ───────────────────────────────────────────────
app.get("/api/switches/helpers/status", async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ ok:false, error:"name required" });

  try {
    const exists = await switchHelpersExist(name);
    res.json({ ok:true, exists });
  } catch (err) {
    res.status(500).json({ ok:false, error:err.message });
  }
});

// Build the ON automation object for a switch
function buildOnAutomation(slug, label, switchEntity, automationCfg) {
  const h   = switchHelperIds(label);
  const cfg = automationCfg || {};
  const sen = cfg.sensor      || {};
  const lev = cfg.levelSensor || {};
  const sensorEid  = sen.entity  || "sensor.unknown";
  const level1Eid  = lev.entity1 || "binary_sensor.unknown";

  return {
    id:    `aquarium_${slug}_on`,
    alias: `Aquarium ${label} — ON`,
    description: `Auto-generated by Aquarium Controller. Controls ${switchEntity} based on mode stored in ${h.mode}.`,
    mode: "single",
    trigger: [
      // Fires every minute — schedule + sensor + level mode all rely on this
      { platform: "time_pattern", minutes: "/1" },
      // Binary sensor state changes for level mode (faster response)
      { platform: "state", entity_id: level1Eid, to: "on", id: "level1_on" },
    ],
    condition: [
      {
        condition: "or",
        conditions: [
          // ── SCHEDULE MODE ──────────────────────────────────────────────────
          {
            condition: "and",
            conditions: [
              { condition: "template", value_template: `{{ states('${h.mode}') == 'schedule' }}` },
              { condition: "template", value_template: `{{ now().strftime('%H:%M') == states('${h.scheduleOn}') }}` },
              { condition: "template", value_template: `{{ is_state('${switchEntity}', 'off') }}` },
            ],
          },
          // ── SENSOR MODE ────────────────────────────────────────────────────
          {
            condition: "and",
            conditions: [
              { condition: "template", value_template: `{{ states('${h.mode}') == 'sensor' }}` },
              { condition: "template", value_template: `{{ states('${h.triggerType}') == 'low' and states(states('${h.sensorEntity}')) | float(0) <= states('${h.onThreshold}') | float(0) }}` },
              { condition: "template", value_template: `{{ is_state('${switchEntity}', 'off') }}` },
            ],
          },
          {
            condition: "and",
            conditions: [
              { condition: "template", value_template: `{{ states('${h.mode}') == 'sensor' }}` },
              { condition: "template", value_template: `{{ states('${h.triggerType}') == 'high' and states(states('${h.sensorEntity}')) | float(0) >= states('${h.onThreshold}') | float(0) }}` },
              { condition: "template", value_template: `{{ is_state('${switchEntity}', 'off') }}` },
            ],
          },
          // ── LEVEL MODE (single) ────────────────────────────────────────────
          {
            condition: "and",
            conditions: [
              { condition: "template", value_template: `{{ states('${h.mode}') == 'level' }}` },
              { condition: "template", value_template: `{{ states('${h.levelEntity1}') == 'on' and (states('${h.levelEntity2}') in ['', 'unknown', 'unavailable'] or states('${h.levelEntity2}') == 'on') }}` },
              { condition: "template", value_template: `{{ is_state('${switchEntity}', 'off') }}` },
            ],
          },
        ],
      },
    ],
    action: [
      { service: "switch.turn_on", target: { entity_id: switchEntity } },
    ],
  };
}

// Build the OFF automation object for a switch
function buildOffAutomation(slug, label, switchEntity, automationCfg) {
  const h   = switchHelperIds(label);
  const cfg = automationCfg || {};
  const lev = cfg.levelSensor || {};

  return {
    id:    `aquarium_${slug}_off`,
    alias: `Aquarium ${label} — OFF`,
    description: `Auto-generated by Aquarium Controller. Controls ${switchEntity} based on mode stored in ${h.mode}.`,
    mode: "single",
    trigger: [
      { platform: "time_pattern", minutes: "/1" },
      // Binary sensor state changes for level mode
      { platform: "state", entity_id: lev.entity1 || "binary_sensor.unknown", to: "off", id: "level1_off" },
    ],
    condition: [
      {
        condition: "or",
        conditions: [
          // ── SCHEDULE MODE ──────────────────────────────────────────────────
          {
            condition: "and",
            conditions: [
              { condition: "template", value_template: `{{ states('${h.mode}') == 'schedule' }}` },
              { condition: "template", value_template: `{{ now().strftime('%H:%M') == states('${h.scheduleOff}') }}` },
              { condition: "template", value_template: `{{ is_state('${switchEntity}', 'on') }}` },
            ],
          },
          // ── SENSOR MODE ────────────────────────────────────────────────────
          {
            condition: "and",
            conditions: [
              { condition: "template", value_template: `{{ states('${h.mode}') == 'sensor' }}` },
              { condition: "template", value_template: `{{ states('${h.triggerType}') == 'low' and states(states('${h.sensorEntity}')) | float(0) >= states('${h.offThreshold}') | float(0) }}` },
              { condition: "template", value_template: `{{ is_state('${switchEntity}', 'on') }}` },
            ],
          },
          {
            condition: "and",
            conditions: [
              { condition: "template", value_template: `{{ states('${h.mode}') == 'sensor' }}` },
              { condition: "template", value_template: `{{ states('${h.triggerType}') == 'high' and states(states('${h.sensorEntity}')) | float(0) <= states('${h.offThreshold}') | float(0) }}` },
              { condition: "template", value_template: `{{ is_state('${switchEntity}', 'on') }}` },
            ],
          },
          // ── LEVEL MODE (dual — both sensors on = full = turn off) ──────────
          {
            condition: "and",
            conditions: [
              { condition: "template", value_template: `{{ states('${h.mode}') == 'level' }}` },
              { condition: "template", value_template: `{{ states('${h.levelEntity1}') == 'off' and states('${h.levelEntity2}') == 'off' }}` },
              { condition: "template", value_template: `{{ is_state('${switchEntity}', 'on') }}` },
            ],
          },
          // ── LEVEL MODE (single — sensor off = turn off) ────────────────────
          {
            condition: "and",
            conditions: [
              { condition: "template", value_template: `{{ states('${h.mode}') == 'level' }}` },
              { condition: "template", value_template: `{{ states('${h.levelEntity2}') in ['', 'unknown', 'unavailable'] and states('${h.levelEntity1}') == 'off' }}` },
              { condition: "template", value_template: `{{ is_state('${switchEntity}', 'on') }}` },
            ],
          },
        ],
      },
    ],
    action: [
      { service: "switch.turn_off", target: { entity_id: switchEntity } },
    ],
  };
}

// Push both automations to HA and reload
async function pushAutomationsToHA(name, switchEntity, automationCfg) {
  const slug  = nameToSlug(name);
  const onAuto  = buildOnAutomation(slug, name, switchEntity, automationCfg);
  const offAuto = buildOffAutomation(slug, name, switchEntity, automationCfg);

  const results = {};
  try {
    results.on  = await haRest("POST", `/api/config/automation/config/${onAuto.id}`,  onAuto);
    results.off = await haRest("POST", `/api/config/automation/config/${offAuto.id}`, offAuto);
    // Reload automations so changes take effect immediately
    await haRest("POST", "/api/services/automation/reload", {});
    results.reloaded = true;
  } catch(e) {
    results.error = e.message;
  }
  return results;
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
  const switches    = s?.switches || {};
  const automations = s?.switchAutomation || {};
  const result = Object.entries(switches).map(([key, cfg], i) => ({
    id:         i + 1,
    key,
    name:       cfg.name   || key,
    entity:     cfg.entity,
    state:      haState[cfg.entity]?.state ?? "unknown",
    power:      haState[cfg.entity]?.attributes?.current_power_w ?? null,
    watts:      cfg.watts  || 0,
    icon:       cfg.icon   || "⏻",
    automation: automations[i + 1] || null,
    // Slug so the UI can check/build helper entity IDs without server round-trip
    slug:       nameToSlug(cfg.name || key),
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
// ─── API: SWITCH HA HELPERS — CHECK ──────────────────────────────────────────
// Returns whether the HA helpers exist for a given switch name
app.get("/api/switches/helpers/status", async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "name required" });
  if (!haConnected) return res.json({ exists: false, reason: "HA not connected" });
  try {
    const exists = await switchHelpersExist(name);
    res.json({ exists });
  } catch(e) {
    res.json({ exists: false, reason: e.message });
  }
});

// ─── API: SWITCH HA HELPERS — CREATE ─────────────────────────────────────────
// Creates all 9 HA helpers for a switch. Safe to call multiple times — HA
// returns an error for duplicate IDs which we swallow gracefully.
app.post("/api/switches/helpers/create", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  if (!haConnected) return res.status(503).json({ error: "HA not connected" });
  try {
    const result = await createSwitchHelpers(name);
    res.json(result);
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── API: SWITCH HA AUTOMATION — PUSH ────────────────────────────────────────
// Writes helper values from swState then pushes both ON/OFF automations to HA.
// Called from the Save Automation button on the Switches page.
app.post("/api/switches/ha-automation", async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "id required" });
  if (!haConnected) return res.status(503).json({ error: "HA not connected" });

  const s      = loadSettings();
  const sw     = Object.values(s?.switches || {})[parseInt(id) - 1];
  const autoCfg = s?.switchAutomation?.[id] || {};

  if (!sw?.name)   return res.status(400).json({ error: "Switch not found" });
  if (!sw?.entity) return res.status(400).json({ error: "Switch has no entity configured" });

  try {
    // 1. Sync helper values to HA
    await syncHelpersFromState(sw.name, sw.entity, autoCfg);

    // 2. Push both automations to HA
    const result = await pushAutomationsToHA(sw.name, sw.entity, autoCfg);

    console.log(`🤖 HA automations pushed for switch ${id} (${sw.name}):`, result);
    res.json({ ok: !result.error, ...result });
  } catch(e) {
    console.error("ha-automation push error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
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

// ─── HELPER: collect all binary sensor entity configs from both sources ────────
// Source 1: settings.levelSensors (the dedicated binary sensors settings section)
// Source 2: settings.switchAutomation[*].levelSensor (configured per-switch)
function getAllBinarySensorConfigs(s) {
  const normalizeType = t => ({ high:"level", low:"level", leak:"leak" }[t] || t || "level");
  const configs = [];
  const seen = new Set();

  // Source 1: global levelSensors list
  const ls = s?.levelSensors || {};
  Object.entries(ls).forEach(([key, cfg]) => {
    if (!cfg.entity || seen.has(cfg.entity)) return;
    seen.add(cfg.entity);
    configs.push({
      key,
      name:   cfg.name   || key,
      entity: cfg.entity,
      type:   normalizeType(cfg.type),
      invert: !!cfg.invert,
    });
  });

  // Source 2: levelSensor sub-object inside each switchAutomation entry
  const automations = s?.switchAutomation || {};
  const switches    = s?.switches || {};
  Object.entries(automations).forEach(([id, cfg]) => {
    const levelSensor = cfg?.levelSensor;
    if (!levelSensor) return;
    const swCfg = Object.values(switches)[parseInt(id) - 1];
    const swName = swCfg?.name || `Switch ${id}`;
    const mode   = levelSensor.mode || "single";
    const entities = mode === "single"
      ? [levelSensor.entity1]
      : [levelSensor.entity1, levelSensor.entity2];
    entities.filter(Boolean).forEach((entity, i) => {
      if (seen.has(entity)) return;
      seen.add(entity);
      configs.push({
        key:    `sw${id}_${i + 1}`,
        name:   mode === "single" ? swName : `${swName} ${i === 0 ? "(High)" : "(Low)"}`,
        entity,
        type:   "level",
        invert: false,
      });
    });
  });

  return configs;
}

// ─── API: BINARY SENSORS ─────────────────────────────────────────────────────
app.get("/api/binary-sensors", (req, res) => {
  try {
    const s = loadSettings();
    const configs = getAllBinarySensorConfigs(s);

    const result = configs.map((cfg, i) => {
      const rawState = cfg.entity ? (haState[cfg.entity]?.state ?? "unknown") : "unknown";
      const invert   = !!cfg.invert;
      let state = rawState;
      if (invert && rawState === "on")  state = "off";
      if (invert && rawState === "off") state = "on";
      return {
        id: i + 1,
        key:    cfg.key,
        name:   cfg.name,
        entity: cfg.entity,
        type:   cfg.type,
        invert,
        rawState,
        state,
      };
    });
    res.json(result);
  } catch(err) {
    console.error("binary-sensors route error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Keep old endpoint as alias so switches.html poll doesn't break
app.get("/api/level-sensors", (req, res) => res.redirect("/api/binary-sensors"));

// ─── API: ALL SENSORS (for switch sensor-mode dropdown) ───────────────────────
// Returns built-in numeric sensors + custom numeric sensors + binary sensors
app.get("/api/sensors/all", (req, res) => {
  const s = loadSettings();
  const sensors = s?.sensors || {};
  const result = [];

  // Built-in numeric sensors
  const builtins = [
    { key:"temperature", label:"Temperature", unit:"°C" },
    { key:"ph",          label:"pH",          unit:""   },
    { key:"orp",         label:"ORP",         unit:"mV" },
    { key:"kh",          label:"KH",          unit:"dKH" },
  ];
  builtins.forEach(def => {
    const cfg = sensors[def.key] || {};
    if (cfg.active === false || !cfg.primary) return;
    result.push({
      value: cfg.primary,
      label: def.label,
      unit:  def.unit,
      type:  "numeric",
    });
  });

  // Custom numeric sensors
  const custom = sensors?.custom || {};
  Object.values(custom).forEach(cfg => {
    if (!cfg.entity) return;
    const unit = cfg.unit === "custom" ? cfg.customUnit : (cfg.unit === "none" ? "" : cfg.unit);
    result.push({
      value: cfg.entity,
      label: cfg.name || cfg.entity,
      unit,
      type: "numeric",
    });
  });

  // Binary sensors — from both levelSensors and switchAutomation
  getAllBinarySensorConfigs(s).forEach(cfg => {
    const typeLabel = { level:"Level Sensor", leak:"Leak Detector", other:"Binary Sensor" }[cfg.type] || cfg.type;
    result.push({
      value:     cfg.entity,
      label:     `${cfg.name} (${typeLabel})`,
      unit:      "",
      type:      "level",
      levelType: cfg.type,
      invert:    cfg.invert,
    });
  });

  res.json(result);
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🐠 Aquarium Controller → http://localhost:${PORT}`);
  const cfg = loadConfig();
  if (cfg.host && cfg.token) connectHA(cfg);
  else console.log("💡 Open Settings to configure HA connection.");
});
