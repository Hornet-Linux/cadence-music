// electron-builder afterPack hook, macOS only. On a Mac the Widevine VMP
// signature has to be added before the app is code-signed, and Apple Silicon
// refuses to run unsigned code. With no Apple Developer certificate the app is
// then signed ad hoc ("-"), which runs but isn't notarized, so the first launch
// needs right-click → Open (or System Settings → Privacy & Security → Open Anyway).
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { vmpSignPackage } = require("./vmp-sign.cjs");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.VMP_SIGN === "1") vmpSignPackage(context.appOutDir);
  else console.log("  • skipping Widevine VMP signing (no castlabs EVS credentials)");

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc code signing ${app}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
