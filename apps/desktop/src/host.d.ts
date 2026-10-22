import type { HostBridge } from "../electron/preload";

/**
 * Offered by the iOS and Android shells (on-device AI such as Apple Intelligence
 * and Gemini Nano) and, on Android, app controls. Absent in browsers and the
 * desktop app.
 */
export interface CadenceNativeBridge {
  /** Which app shell this is. Set by the Android app. */
  platform?: string;
  /** Go back to the app's server address screen. Set by the Android app. */
  changeServer?(): void;
  /** Shown to the listener, e.g. "Apple Intelligence". */
  aiName?: string;
  /** Whether the model can run right now on this device. */
  aiAvailable(): boolean | Promise<boolean>;
  /**
   * Run a chat. `requestJson` is `{ messages, schema, temperature? }` as JSON;
   * resolves with the model's reply text, which should be a JSON object.
   */
  aiChatJson(requestJson: string): Promise<string>;
}

declare global {
  interface Window {
    host: HostBridge;
    CadenceNative?: CadenceNativeBridge;
  }
}

export {};
