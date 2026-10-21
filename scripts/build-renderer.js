const { build } = require('esbuild');
const path = require('node:path');
build({ entryPoints: [path.resolve(__dirname, '../src/editor-entry.mjs')], bundle: true,
  outfile: path.resolve(__dirname, '../src/vendor/editor.js'), format: 'iife', globalName: 'PasteEditor',
  platform: 'browser', target: 'chrome130', minify: true, legalComments: 'eof' }).catch(error => { console.error(error); process.exitCode = 1; });
