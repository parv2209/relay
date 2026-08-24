// server.js — Relay: a multi-provider AI gateway with key rotation & fallback
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DATA_FILE = path.join(__dirname, "data", "providers.json");

// ---------------------------------------------------------
// Presets: known provider "shapes" — the frontend picks one of these
// when a user adds a key, so we know how to format requests/responses.
// ---------------------------------------------------------
const PRESETS = {
  groq: {
    label: "Groq",
    format: "openai",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "llama-3.1-8b-instant",
    needsKey: true
  },
  gemini: {
    label: "Google Gemini",
    format: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    defaultModel: "gemini-1.5-flash",
    needsKey: true
  },
  openrouter: {
    label: "OpenRouter",
    format: "openai",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "meta-llama/llama-3.1-8b-instruct:free",
    needsKey: true
  },
  together: {
    label: "Together AI",
    format: "openai",
    baseUrl: "https://api.together.xyz/v1/chat/completions",
    defaultModel: "meta-llama/Llama-3.2-3B-Instruct-Turbo",
    needsKey: true
  },
  ollama: {
    label: "Ollama (local)",
    format: "ollama",
    baseUrl: "http://localhost:11434/api/chat",
    defaultModel: "llama3",
    needsKey: false
  }
};

// ---------------------------------------------------------
// Storage: providers persisted to a JSON file on disk.
// Each entry: { id, type, label, key, model, cooldownUntil, uses, addedAt }
// ---------------------------------------------------------
function loadProviders() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveProviders(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

let providers = loadProviders();
let cursor = 0;
let activeProvider = null;
const logs = []; // in-memory routing log, most recent first

function addLog(entry) {
  logs.unshift({ ts: Date.now(), ...entry });
  if (logs.length > 200) logs.pop();
}

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return "••••";
  return key.slice(0, 4) + "••••" + key.slice(-4);
}

function publicView(p) {
  return {
    id: p.id,
    type: p.type,
    label: p.label,
    model: p.model,
    keyMasked: maskKey(p.key),
    uses: p.uses,
    cooldownUntil: p.cooldownUntil,
    onCooldown: p.cooldownUntil > Date.now(),
    addedAt: p.addedAt
  };
}

// ---------------------------------------------------------
// Rotation: reuse the current provider until it hits a hard failure,
// then switch to the next available one when a fallback is needed.
// ---------------------------------------------------------
function getNextAvailable(excludeId = null) {
  const now = Date.now();
  const startIndex = activeProvider
    ? providers.findIndex(entry => entry.id === activeProvider.id)
    : cursor % providers.length;
  const begin = startIndex >= 0 ? startIndex : cursor % providers.length;

  for (let offset = 0; offset < providers.length; offset++) {
    const idx = (begin + offset) % providers.length;
    const entry = providers[idx];
    if (!entry) continue;
    if (entry.id === excludeId) continue;
    if (entry.cooldownUntil >= now) continue;

    cursor = (idx + 1) % providers.length;
    activeProvider = entry;
    return entry;
  }
  return null;
}

function isTokenLimitError(err) {
  const candidates = [
    err?.message,
    err?.error?.message,
    err?.response?.data?.error?.message,
    err?.response?.body?.error?.message,
    err?.response?.data?.message,
    err?.body?.error?.message,
    typeof err === "string" ? err : ""
  ].filter(Boolean);

  const message = candidates.join(" ").toLowerCase();
  return (
    (message.includes("token") && (message.includes("limit") || message.includes("exceeded") || message.includes("expired"))) ||
    (message.includes("context") && (message.includes("length") || message.includes("limit"))) ||
    message.includes("maximum context")
  );
}

function handleTokenLimitError(entry, err) {
  if (!entry || !isTokenLimitError(err)) return null;

  addLog({ type: "cooldown", provider: entry.label, message: "Token limit reached; switching provider." });
  markCooldown(entry);
  activeProvider = null;
  return getNextAvailable(entry.id);
}

function markCooldown(entry, ms = 60_000) {
  entry.cooldownUntil = Date.now() + ms;
  saveProviders(providers);
}

// ---------------------------------------------------------
// Adapters: translate the common { role, content }[] shape into
// each provider's expected request, and parse their reply back out.
// ---------------------------------------------------------
async function callProvider(entry, messages) {
  const preset = PRESETS[entry.type];

  if (preset.format === "openai") {
    const res = await fetch(preset.baseUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${entry.key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: entry.model, messages })
    });
    if (res.status === 429) throw { rateLimited: true };
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || JSON.stringify(data));
    return data.choices[0].message.content;
  }

  if (preset.format === "gemini") {
    const url = preset.baseUrl.replace("{model}", entry.model) + `?key=${entry.key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: messages
          .filter(m => m.role !== "system")
          .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }))
      })
    });
    if (res.status === 429) throw { rateLimited: true };
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || JSON.stringify(data));
    return data.candidates[0].content.parts[0].text;
  }

  if (preset.format === "ollama") {
    const res = await fetch(entry.baseUrl || preset.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: entry.model, messages, stream: false })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data.message.content;
  }

  throw new Error("Unknown provider format: " + preset.format);
}

// ---------------------------------------------------------
// Gateway: re-use the current provider until it fails, then automatically
// switch to the next available provider for token-limit errors.
// ---------------------------------------------------------
async function routeChat(messages, retriesLeft) {
  if (retriesLeft === undefined) retriesLeft = providers.length;
  const entry = activeProvider && activeProvider.cooldownUntil < Date.now()
    ? activeProvider
    : getNextAvailable();

  if (!entry) {
    addLog({ type: "error", message: "All providers are on cooldown." });
    throw new Error("All providers are currently on cooldown. Add another key or wait a moment.");
  }

  try {
    const text = await callProvider(entry, messages);
    entry.uses++;
    saveProviders(providers);
    addLog({ type: "success", provider: entry.label, model: entry.model });
    return { text, usedProvider: entry.label, providerId: entry.id };
  } catch (err) {
    const fallbackEntry = handleTokenLimitError(entry, err);
    if (fallbackEntry && retriesLeft > 0) {
      addLog({ type: "cooldown", provider: entry.label, message: "Switching to next provider after token-limit error." });
      return routeChat(messages, retriesLeft - 1);
    }

    if (err.rateLimited && retriesLeft > 0) {
      addLog({ type: "cooldown", provider: entry.label });
      markCooldown(entry);
      return routeChat(messages, retriesLeft - 1);
    }

    addLog({ type: "error", provider: entry.label, message: err.message || String(err) });
    throw err;
  }
}

// ---------------------------------------------------------
// Routes
// ---------------------------------------------------------
app.get("/api/presets", (req, res) => {
  const out = {};
  for (const [key, val] of Object.entries(PRESETS)) {
    out[key] = { label: val.label, defaultModel: val.defaultModel, needsKey: val.needsKey };
  }
  res.json(out);
});

app.get("/api/providers", (req, res) => {
  res.json(providers.map(publicView));
});

app.post("/api/providers", (req, res) => {
  const { type, label, key, model, baseUrl } = req.body;
  const preset = PRESETS[type];
  if (!preset) return res.status(400).json({ error: "Unknown provider type." });
  if (preset.needsKey && !key) return res.status(400).json({ error: "This provider needs an API key." });

  const entry = {
    id: crypto.randomUUID(),
    type,
    label: label || preset.label,
    key: key || null,
    model: model || preset.defaultModel,
    baseUrl: baseUrl || null,
    cooldownUntil: 0,
    uses: 0,
    addedAt: Date.now()
  };
  providers.push(entry);
  saveProviders(providers);
  addLog({ type: "info", message: `Added ${entry.label}` });
  res.json(publicView(entry));
});

app.delete("/api/providers/:id", (req, res) => {
  const before = providers.length;
  providers = providers.filter(p => p.id !== req.params.id);
  saveProviders(providers);
  if (providers.length < before) addLog({ type: "info", message: "Removed a provider" });
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: "Missing 'message'." });
  if (providers.length === 0) return res.status(400).json({ error: "No providers added yet." });

  const messages = [...(history || []), { role: "user", content: message }];
  try {
    const result = await routeChat(messages);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/logs", (req, res) => {
  res.json(logs);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Relay running at http://localhost:${PORT}`);
});
