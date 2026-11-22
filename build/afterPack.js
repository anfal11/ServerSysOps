// electron-builder afterPack hook.
//
// macOS: the app is distributed without an Apple Developer ID. electron-builder then skips signing entirely,
// but a bundle it has repacked no longer matches Electron's original ad-hoc signature, and Gatekeeper reports
// such an app as "damaged" instead of "from an unidentified developer". Re-signing ad-hoc ("-") gives every
// binary a valid signature again, so the usual right-click → Open (or Privacy & Security → Open Anyway) works,
// and arm64 Macs (which refuse unsigned code outright) can launch it.
const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
}
