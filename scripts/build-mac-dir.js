#!/usr/bin/env node

const { createPackage } = require('@electron/asar');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const packageJson = require(path.join(rootDir, 'package.json'));
const appName = packageJson.productName || 'Paste Easy';
const appId = packageJson.build?.appId || 'com.zhongkouwei.pastelike';
const electronApp = path.join(rootDir, 'node_modules', 'electron', 'dist', 'Electron.app');
const outDir = path.join(rootDir, 'release', 'mac-arm64');
const outApp = path.join(outDir, `${appName}.app`);

function copyAppSource(tempDir) {
  const appSource = path.join(tempDir, 'app');
  fs.mkdirSync(appSource, { recursive: true });
  fs.cpSync(path.join(rootDir, 'src'), path.join(appSource, 'src'), { recursive: true });
  fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(appSource, 'package.json'));
  fs.copyFileSync(path.join(rootDir, 'package-lock.json'), path.join(appSource, 'package-lock.json'));
  return appSource;
}

function updateInfoPlist(plistPath) {
  const replacements = [
    ['CFBundleDisplayName', appName],
    ['CFBundleName', 'Electron'],
    ['CFBundleExecutable', 'Electron'],
    ['CFBundleIdentifier', appId],
    ['LSUIElement', 'true', '-bool']
  ];

  for (const [key, value, type = '-string'] of replacements) {
    execFileSync('plutil', ['-replace', key, type, value, plistPath]);
  }
}

function replacePlistString(plistPath, key, value) {
  execFileSync('plutil', ['-replace', key, '-string', value, plistPath]);
}

function renameBundleItem(from, to) {
  if (fs.existsSync(from)) {
    fs.renameSync(from, to);
  }
}

function renameElectronBundle(appPath) {
  const contentsDir = path.join(appPath, 'Contents');
  const macOsDir = path.join(contentsDir, 'MacOS');
  const frameworksDir = path.join(contentsDir, 'Frameworks');
  const frameworkName = `${appName} Framework`;
  const oldFrameworkPath = path.join(frameworksDir, 'Electron Framework.framework');
  const newFrameworkPath = path.join(frameworksDir, `${frameworkName}.framework`);
  const newFrameworkBinary = path.join(newFrameworkPath, frameworkName);

  renameBundleItem(path.join(macOsDir, 'Electron'), path.join(macOsDir, appName));
  renameBundleItem(oldFrameworkPath, newFrameworkPath);
  renameBundleItem(
    path.join(newFrameworkPath, 'Versions', 'A', 'Electron Framework'),
    path.join(newFrameworkPath, 'Versions', 'A', frameworkName)
  );
  fs.rmSync(path.join(newFrameworkPath, 'Electron Framework'), { force: true });
  fs.symlinkSync(path.join('Versions', 'Current', frameworkName), newFrameworkBinary);

  const mainBinary = path.join(macOsDir, appName);
  execFileSync('install_name_tool', [
    '-change',
    '@rpath/Electron Framework.framework/Electron Framework',
    `@rpath/${frameworkName}.framework/${frameworkName}`,
    mainBinary
  ]);
  execFileSync('install_name_tool', [
    '-id',
    `@rpath/${frameworkName}.framework/${frameworkName}`,
    newFrameworkBinary
  ]);

  const helperSuffixes = ['', ' (GPU)', ' (Plugin)', ' (Renderer)'];
  for (const suffix of helperSuffixes) {
    const oldHelperName = `Electron Helper${suffix}`;
    const newHelperName = `${appName} Helper${suffix}`;
    const oldHelperApp = path.join(frameworksDir, `${oldHelperName}.app`);
    const newHelperApp = path.join(frameworksDir, `${newHelperName}.app`);
    renameBundleItem(oldHelperApp, newHelperApp);
    renameBundleItem(
      path.join(newHelperApp, 'Contents', 'MacOS', oldHelperName),
      path.join(newHelperApp, 'Contents', 'MacOS', newHelperName)
    );
    const helperPlist = path.join(newHelperApp, 'Contents', 'Info.plist');
    replacePlistString(helperPlist, 'CFBundleName', newHelperName);
    replacePlistString(helperPlist, 'CFBundleExecutable', newHelperName);
    replacePlistString(helperPlist, 'CFBundleIdentifier', `${appId}.helper${suffix.toLowerCase().replace(/[^a-z]+/g, '-')}`);
  }
}

function adHocSign(appPath) {
  try {
    execFileSync('xattr', ['-cr', appPath]);
    execFileSync('codesign', [
      '--force',
      '--deep',
      '--sign',
      '-',
      appPath
    ], { stdio: 'inherit' });
  } catch (error) {
    console.warn(`Skipping ad-hoc codesign: ${error.message}`);
  }
}

async function main() {
  if (!fs.existsSync(electronApp)) {
    throw new Error(`Electron.app not found at ${electronApp}`);
  }

  fs.rmSync(outApp, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(electronApp, outApp, { recursive: true, verbatimSymlinks: true });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-easy-build-'));
  try {
    const appSource = copyAppSource(tempDir);
    const resourcesDir = path.join(outApp, 'Contents', 'Resources');
    await createPackage(appSource, path.join(resourcesDir, 'app.asar'));
    updateInfoPlist(path.join(outApp, 'Contents', 'Info.plist'));
    adHocSign(outApp);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`Built ${outApp}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
