/**
 * True when the UI runs as the web player (a browser, or the Android/iOS app's
 * WebView): `main.tsx` puts the "web" class on <html> in that case. The desktop
 * app is the only place with "files on this computer" and a server address to type.
 */
export function isWebPlayer(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("web");
}
