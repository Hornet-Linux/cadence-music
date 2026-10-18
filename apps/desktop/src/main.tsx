import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { completeWebRedirects, webHost } from "@/platform/webHost";
import "@/app/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

// In the desktop app the Electron preload provides window.host; in a browser
// (the web player at /app) the web bridge stands in for it.
const isBrowser = !window.host;
if (isBrowser) {
  window.host = webHost;
  document.documentElement.classList.add("web");
}

const render = () =>
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

if (isBrowser) void completeWebRedirects().finally(render);
else render();
