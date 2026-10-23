# Community plugins

Each plugin is a folder here with an `index.ts` or `index.tsx` whose default export is a
`Plugin` (or an array of them). It is picked up automatically; do not edit any shared file.
Keep one plugin per folder, put its tests next to it, and request only the capabilities it needs.
