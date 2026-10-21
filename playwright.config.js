const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: './test/ui', timeout: 45000, workers: 1, fullyParallel: false,
  reporter: 'list', use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' } });
