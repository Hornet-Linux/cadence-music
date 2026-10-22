import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { startRelay } from "@/features/dj/relayClient";
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
} else if (window.host?.platform === "darwin") {
  document.documentElement.classList.add("mac");
}

const render = () => {
  // Offer this device's shared AI providers to the person's other devices.
  startRelay();
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
};

if (isBrowser) void completeWebRedirects().finally(render);
else render();
