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
machines on your network. The server rejects base URLs that contain a
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

`POST /api/dj/picks` builds its own prompt, so a signed-in account can't use
the server's API credits for arbitrary prompts through it. It is limited to 20
requests per person per 10 minutes and one at a time.

The AI plugins below (song chat, playlist builder, taste summary) need
free-form questions, so they use `POST /api/llm/chat`, which relays a prompt the
app built. That does let a signed-in person spend the server's credits on their
own prompts, within tight bounds: 60 requests per person per 10 minutes, at most
3 answers at once, 32,000 characters in and 20,000 out, and errors from the
provider are hidden from non-admins as for the DJ. Set `LLM_CHAT_DISABLED=1` in
the server's environment to switch the route off (the DJ keeps working).

## AI plugins

Six community plugins build on the DJ and use the provider chosen in Settings →
AI DJ (the same server, device, local or on-device providers). Turn them on in
Settings → Plugins; each shows a pointer to Settings → AI DJ when no provider
works.

| Plugin | What it does |
| --- | --- |
| DJ personalities | Warm, dry, calm, hype or minimal hosts, or your own. Changes how the model words intros (`style`) and the system voice's rate, pitch and voice. |
| AI playlist builder | "Rainy Sunday cooking" becomes a playlist. Every song is looked up in your server library, Jellyfin or Spotify; made-up songs are never played. |
| Ask about this song | A chat with the current song as context, streamed when the provider can stream. |
| Mood radio | Focus, workout, sleep, party and commute radio that tops up the queue and feeds skips and finished songs back to the model. |
| Neural voices | Speaks intros through an OpenAI-compatible `/v1/audio/speech` server (OpenAI, Kokoro, Piper). Falls back to the system voice. The server must allow browser requests (CORS). |
| Taste summary | "Your taste in three paragraphs". Only aggregate counts are sent, only when you press the button, and the screen shows exactly what is sent. |

Whatever a model (or a device) returns is bounded before it reaches an app: at
most 25 picks, artist and title cut to 200 characters, the intro to 400, and
control characters replaced with spaces.
