import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import renderer from "vite-plugin-electron-renderer";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: [
    react(),
    electron([
      { entry: "electron/main.ts" },
      {
        entry: "electron/preload.ts",
        onstart(args) {
          args.reload();
        },
      },
    ]),
    renderer(),
  ],
});
