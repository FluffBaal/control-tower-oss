// Example Playwright config for a project driven by the Control Tower test kit.
// The kit sets CT_RUN_DIR (per-run output), PORT, and BASE_URL. Two reporters land
// under the run dir: `blob` (the human merge artifact, a zipped tree) and `json`
// (the machine-parseable report the Tower folds into TestRun.results at release —
// SPEC-STORYLOOP §2.1). This is the reporter pair projects copy.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [
    ['blob', { outputDir: (process.env.CT_RUN_DIR ?? '.') + '/blob' }],
    ['json', { outputFile: (process.env.CT_RUN_DIR ?? '.') + '/results.json' }],
  ],
  use: { headless: true },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: { args: ['--no-sandbox'] } } },
  ],
});
