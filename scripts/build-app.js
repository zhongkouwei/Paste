const { build, Platform } = require('electron-builder');
const release = process.argv.includes('--release');
if (release && !process.env.CSC_NAME) throw new Error('A Developer ID Application signing identity is required in CSC_NAME.');
if (release && !((process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
  || (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID))) {
  throw new Error('Apple notarization credentials are required for release builds.');
}
build({ targets: Platform.MAC.createTarget('dir'), config: { mac: {
  identity: release ? process.env.CSC_NAME : '-', notarize: release
} } }).then(() => {
  console.log(release ? 'Signed release built; verify notarization before distribution.' : 'Development build only: ad-hoc signed, not notarized for distribution.');
}).catch(error => { console.error(error); process.exitCode = 1; });
