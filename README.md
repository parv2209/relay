# Relay

A local AI gateway with a proper UI: add API keys from multiple free-tier
providers (Groq, Gemini, OpenRouter, Together, or a local Ollama model), and
Relay rotates across them automatically — falling back to the next key the
moment one gets rate-limited.

## Run it

```bash
cd relay
npm install
npm start
```

Then open **http://localhost:3000**.

## How it works

- **Add a provider** — pick a preset (Groq, Gemini, etc.), paste your key,
  confirm the model, and it's added to your pool. Keys are stored locally in
  `data/providers.json` and never leave your machine except to call the
  provider you chose.
- **Console** — send a test message. Relay picks the next available provider
  in rotation, and if that one is rate-limited (HTTP 429), it automatically
  puts it on a 60-second cooldown and retries the next one — invisibly, from
  one message.
- **Routing log / visualizer** — every request is logged with which provider
  served it, and the hero diagram pulses live from "you" to whichever
  provider handled the last request.

## Adding more providers

Every provider is defined once in `server.js` under `PRESETS`. To add a new
one, give it a `format` (`"openai"` for any OpenAI-compatible API, `"gemini"`
for Google's API, or `"ollama"` for local Ollama), a `baseUrl`, and a
`defaultModel`. The adapter layer (`callProvider`) already knows how to talk
to all three shapes — most new providers (Mistral, Fireworks, Cerebras, etc.)
speak the OpenAI-compatible format out of the box.

## Worth knowing

This pools several separate free-tier limits into one bigger combined
ceiling — it isn't literally unlimited. A few providers' terms of service
restrict automated key-rotation to dodge rate limits, so it's worth a quick
check on the providers you add before leaning on this hard. Keys are stored
in plain text locally, which is fine for personal use on your own machine,
but isn't a setup you'd want to expose to other people as-is.
