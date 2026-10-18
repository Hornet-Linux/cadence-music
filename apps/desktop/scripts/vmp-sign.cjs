// electron-builder afterSign hook: Widevine VMP-sign the packaged app with
// castlabs EVS, which DRM license servers (Spotify, Apple Music) require from
// production builds. Runs only when CI has signed in to EVS and set VMP_SIGN=1;
// otherwise the build stays unsigned and DRM playback may be refused.
// https://github.com/castlabs/electron-releases/wiki/EVS
const { execFileSync } = require("node:child_process");

module.exports = async function vmpSign(context) {
  if (process.env.VMP_SIGN !== "1") {
    console.log("  • skipping Widevine VMP signing (no castlabs EVS credentials)");
    return;
  }
  const python = process.platform === "win32" ? "python" : "python3";
  console.log(`  • VMP-signing ${context.appOutDir}`);
  execFileSync(python, ["-m", "castlabs_evs.vmp", "sign-pkg", context.appOutDir], { stdio: "inherit" });
};
