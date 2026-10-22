# Community server plugins

One folder per plugin: `src/community/<name>/plugin.ts`, default-exporting a `ServerPlugin` (or an array).
It is found automatically; the admin turns it on (Settings > Plugins), and a restart applies the change.
Keep tests next to the plugin as `*.test.ts`. Routes go under `/api/<area>`.

Optional metadata shown on the admin panel's **Plugins** page: `description` (one sentence) and
`configFields` (a list of `{ key, label, type?, help?, placeholder? }`). With `configFields` the admin gets a
form; without it a JSON editor. Both save to `settings.pluginConfig(id)`. Values under keys named like
`key`, `secret`, `token` or `password` are hidden when shown again. Turning a plugin on or off, or
changing its settings, applies after a server restart (the page says so).
