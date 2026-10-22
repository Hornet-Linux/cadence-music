# Community server plugins

One folder per plugin: `src/community/<name>/plugin.ts`, default-exporting a `ServerPlugin` (or an array).
It is found automatically; the admin turns it on (Settings > Plugins), and a restart applies the change.
Keep tests next to the plugin as `*.test.ts`. Routes go under `/api/<area>`.
