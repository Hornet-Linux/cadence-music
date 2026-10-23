# Community server plugins

One folder per plugin: `src/community/<name>/plugin.ts`, default-exporting a `ServerPlugin` (or an array).
It is found automatically; the admin turns it on (Settings > Plugins), and a restart applies the change.
Keep tests next to the plugin as `*.test.ts`. Routes go under `/api/<area>`.

Every plugin should describe itself for the admin panel's **Plugins** page (one shared shape, `ServerPlugin` in
`src/plugins/types.ts`; `communityMeta.test.ts` checks it for every plugin):

- `description`: one or two sentences on what it does and what it needs.
- `configFields`: the settings the admin can edit, each `{ key, label, type?, help?, placeholder?, default?, options?, sealed? }`.
  `key` may be a dotted path (`"lidarr.url"`). `type` is `text`, `url`, `secret`, `number`, `boolean` or `select`.
  Set `sealed: true` on a secret the plugin stores encrypted through its own routes: the page shows only set / not set and never writes it.
  Leave `configFields` out for a plain JSON editor, or use `[]` when there is nothing to set on this page.
- `configNote`: where to find what the form cannot edit (sealed keys, per-user links, lists managed in the player).
- `adminRoutes` / `userRoutes`: optional lists of the routes it adds, shown in a collapsed list.

Values save to `settings.pluginConfig(id)`; values under keys named like `key`, `secret`, `token` or `password` are hidden
when shown again. Turning a plugin on or off, or changing its settings, applies after a server restart (the page says so).
