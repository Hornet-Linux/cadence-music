import type { HostBridge } from "../electron/preload";

declare global {
  interface Window {
    host: HostBridge;
  }
}

export {};
