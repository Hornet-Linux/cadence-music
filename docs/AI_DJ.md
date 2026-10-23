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
| **Server provider** using the bundled Ollama container (see below) | The server | No key needed |
| **A provider on one of your computers** (Ollama on `localhost`, LM Studio, a key you typed into the desktop app), only if you add one | That computer, via the server relay | That computer only |
| **Calling a provider straight from the app** | The app itself | The app's own storage |

Keys saved on the server cannot be read back through the API, so a lost or
compromised phone cannot leak them. Keys you enter on a device stay on that
device: the desktop app keeps them in its main process (the page can't read
them back) and only sends a key to the address it was saved for, so changing
a provider's address means entering its key again.

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

## Running the model on the server (bundled Ollama)

The simplest setup runs the model on the server itself, so nobody needs Ollama
or an API key on their phone or computer. The compose file includes an
optional Ollama container; `setup.sh` asks about it ("Run the AI DJ on this
server?"), or add it by hand in `deploy/.env`:

```
COMPOSE_PROFILES=https,ollama-gpu   # or "ollama" without an NVIDIA GPU
OLLAMA_URL=http://ollama:11434
OLLAMA_MODEL=llama3.1:8b            # default llama3.2:3b; small models suit a CPU
```

then `docker compose up -d`. On start the server adds **Ollama (this
server)** as an AI provider (the default, unless you already chose one) and
downloads the model in the background; `docker compose logs -f server` shows
when it is ready. From then on the admin panel owns that provider: you can
change its model or turn it off there.

- Ollama is only on the Docker network: no port is published, so only the
  Cadence server can reach it.
- `ollama-gpu` needs an NVIDIA GPU and the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
  on the host. Models live in the `ollama-models` volume.
- To download another model by hand: `docker compose exec ollama ollama pull <model>`
  (`ollama-gpu` for the GPU variant).

Apps no longer come with an "Ollama on this computer" provider: a fresh app
uses the server's provider, and only someone who adds a provider in
Settings → AI DJ calls a model from their own device.

## Setting up a server provider

The easiest way is the **AI providers** page in the admin panel (`/admin`): pick a
starting point (Ollama, LM Studio, OpenAI, Anthropic…), press **Test** to see which
models it has, then **Save**. From there you can also make one the default, turn
one off, edit it or remove it. The same thing through the API, as an admin:

```
POST /api/admin/llm/providers
{ "name": "Home GPU", "kind": "openai-compatible",
  "baseUrl": "http://gpu-box:1234/v1", "model": "qwen2.5-7b-instruct" }
```

`GET /api/admin/llm/providers` lists them (the key is never returned; you get
`hasKey`). `POST /api/admin/llm/test` tries settings before you save them.
The first provider becomes the default; set `isDefault` to change it.
Admin-defined URLs may point anywhere the server can reach, including other
machines on your network. The server never follows a redirect from a
provider, so it only talks to the address an admin typed.

Saved keys are encrypted with a key derived from the server secret and bound
to their provider, so a key copied onto another provider's row in the
database won't decrypt. To rotate `SERVER_SECRET`, set the old value as
`PREVIOUS_SERVER_SECRET` for one start: keys are re-encrypted with the new
secret, and the old one can then be removed. A key that can't be decrypted is
logged on start and shown as "saved key can't be read" in the admin panel. The server rejects base URLs that contain a
username/password, a query string or a fragment, and limits the name to 60
characters, the model to 200 and the API key to 512.

When a server provider fails, ordinary users get a short fixed message ("The AI
provider failed. Ask the server owner to check it.", or a phrase for a rejected
key, a missing model or an unreachable server). The upstream response and any
network detail go to the server log, and admins (and `/api/admin/llm/test`)
still see the full text. Errors from a provider on a person's own computer
are passed through, shortened, because they come from that person's device.

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

Limits: a person can keep at most 5 devices connected (a sixth gets
`429 too_many_devices`; reconnecting a known device id replaces its old
connection and fails that connection's waiting jobs), and at most 4 jobs wait on
one device (8 across a person's devices); beyond that the request fails with
"That device is busy".

## On-device AI (Apple Intelligence, Gemini Nano)

The iOS and Android apps are shells around the web player. When the phone has
its own language model they expose it to the page as `window.CadenceNative`,
and the DJ offers it as a provider ("Apple Intelligence") that needs no server,
no account and no key.

```ts
interface CadenceNativeBridge {
  aiName?: string;                       // shown to the listener
  aiAvailable(): boolean | Promise<boolean>;
  aiChatJson(requestJson: string): Promise<string>;  // { messages, schema, temperature? } -> reply text
}
```

The page sends a trimmed taste profile because on-device models have small
context windows, and parses the first JSON object in the reply. If
`aiAvailable()` is false (older OS, unsupported device, feature turned off) the
option simply doesn't appear. It is chosen automatically only when the server
has no provider of its own.

The bridge exists only on the server's own pages. The iOS app defines
`window.CadenceNative` only when `location.origin` equals the configured
server's origin, and answers the native message handlers only for the main
frame at that origin, so a third-party page the web view lands on (a link or a
sign-in redirect) can't use Apple Intelligence or change the server.

## Limits

`POST /api/dj/picks` is the only endpoint that runs a model for ordinary
users, so a signed-in account can't use the server's API credits for arbitrary
prompts. It is limited to 20 requests per person per 10 minutes and one at a
time; the count is kept in the database, so a restart doesn't reset it.
`POST /api/llm/status` (which also calls the provider) allows 30 checks per
person per 10 minutes; admins aren't limited. A computer sharing its
providers runs at most 2 relay jobs at once.

Whatever a model (or a device) returns is bounded before it reaches an app: at
most 25 picks, artist and title cut to 200 characters, the intro to 400, and
control characters replaced with spaces.
