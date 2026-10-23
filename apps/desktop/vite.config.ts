import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import renderer from "vite-plugin-electron-renderer";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

const appVersion = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig(({ mode }) => {
  // `vite build --mode web` builds the same UI as a website, served by the
  // Cadence server at /app (see apps/server/src/web/webApp.ts).
  if (mode === "web") {
    return {
      base: "/app/",
      resolve: { alias },
      plugins: [
        react(),
        {
          // The server sends the (stricter, plugin-aware) Content-Security-Policy header for /app. A second,
          // fixed policy in a meta tag would be intersected with it and block the opt-in embeds.
          name: "web-csp-from-server",
          apply: "build",
          transformIndexHtml: (html: string) => html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, ""),
        },
      ],
      build: { outDir: "dist-web", emptyOutDir: true },
    };
  }

  return {
    define: { __APP_VERSION__: JSON.stringify(appVersion) },
    resolve: { alias },
    plugins: [
      react(),
      electron([
        { entry: "electron/main.ts" },
        {
          entry: "electron/preload.ts",
          onstart(args) {
            args.reload();
          },
          // Electron only treats a preload as an ES module when it ends in .mjs
          // (it ignores "type": "module"); main.ts loads preload.mjs.
          vite: { build: { lib: { entry: "electron/preload.ts", fileName: () => "[name].mjs" } } },
        },
      ]),
      renderer(),
    ],
  };
});
