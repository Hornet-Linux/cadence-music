# AI DJ: providers and where they run

The AI DJ picks songs with a language model. The picking logic (prompt, reply
schema, cleaning) runs **on the server**, so every app can use it: desktop,
web, iOS and Android. Apps only send a small taste profile and get picks back;
they still check each pick against Spotify themselves, because Spotify tokens
stay on the device.

## Where a model can run

| Where | Who calls it | Who holds the API key |
| --- | --- | --- |
| **Server provider** (set up by the server owner) | The server | The server, encrypted in the database. Never sent to any app. |
| **A provider on one of your computers** (Ollama on `localhost`, LM Studio, a key you typed into the desktop app) | That computer, via the server relay | That computer only |
| **Calling a provider straight from the app** | The app itself | The app's own storage |

Keys saved on the server cannot be read back through the API, so a lost or
compromised phone cannot leak them. Keys you enter on a device stay on that
device.

## Supported providers

Three wire protocols cover nearly everything:

- `ollama`: Ollama's native API.
- `openai-compatible`: OpenAI, LM Studio, llama.cpp, vLLM, Jan, LocalAI,
  OpenRouter, Groq, Together, Mistral, DeepSeek, xAI, Gemini's compatibility
  endpoint and anything else that speaks `/v1/chat/completions`. If a server
  doesn't support strict JSON schemas, the adapter steps down to JSON mode and
  then to a prompt-only mode, and remembers what worked.
- `anthropic`: the Messages API.

`GET /api/llm/presets` lists one-click starting points (URL, whether a key is
needed, whether it only runs locally).

## Setting up a server provider

As an admin (the same account you use for `/admin`):

```
POST /api/admin/llm/providers
{ "name": "Home GPU", "kind": "openai-compatible",
  "baseUrl": "http://gpu-box:1234/v1", "model": "qwen2.5-7b-instruct" }
```

`GET /api/admin/llm/providers` lists them (the key is never returned; you get
`hasKey`). `POST /api/admin/llm/test` tries settings before you save them.
The first provider becomes the default; set `isDefault` to change it.
Admin-defined URLs may point anywhere the server can reach, including other
machines on your network.

## Using a provider on your own computer

An app that wants to offer its local providers to your other devices opens
`POST /api/llm/devices/connect` with a registration (device id, a name, and
each provider's name, kind and model; no URLs or keys) and keeps the request
open. The response is a server-sent event stream:

- `event: job`, data `{ jobId, providerId, op: "status" | "chat-json", request }`
- the app runs the job against its local provider and answers with
  `POST /api/llm/devices/jobs/:jobId` and `{ "ok": true, "data": ... }` or
  `{ "ok": false, "error": "..." }`.

Your other devices then see it in `GET /api/llm/providers` as
`device:<deviceId>:<providerId>` while that app is open. Jobs only ever go to a
device owned by the person who asked.

## Limits

`POST /api/dj/picks` is the only endpoint that runs a model for ordinary
users, so a signed-in account can't use the server's API credits for arbitrary
prompts. It is limited to 20 requests per person per 10 minutes and one at a
time.
