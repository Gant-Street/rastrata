import { defineConfig, devices } from "@playwright/test";

// Lanes (and landings) running on one machine each set RASTRATA_PORT_OFFSET, a multiple of 100.
// Each run has a block of 100 ports, 20000 + offset; this config uses slot 60 (apps/web uses 0 to
// 59 and apps/marketing 70 and 71), so no two runs and no two servers can share a port.
// The process the tests run in is on the same clock as the browser (see `use` below).
process.env.TZ = "UTC";
const offset = Number(process.env.RASTRATA_PORT_OFFSET ?? "0");
if (!Number.isInteger(offset) || offset < 0 || offset > 5000 || offset % 100 !== 0)
  throw new Error("RASTRATA_PORT_OFFSET must be a multiple of 100 from 0 to 5000");
const port = 20_000 + offset + 60;
// Lane landings run one browser (RASTRATA_PLAYWRIGHT_PROJECTS=chromium); main runs all three.
const only = (process.env.RASTRATA_PLAYWRIGHT_PROJECTS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const selected = <T extends { name: string }>(projects: T[]): T[] =>
  only.length === 0
    ? projects
    : projects.filter((project) => only.some((name) => project.name.includes(name)));

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: true,
  // On a shared 16 GiB computer a page can be starved for ten seconds by something else: RASTRATA_PLAYWRIGHT_RETRIES=1 lets a test that failed once run again, and one that fails twice
  // has failed. By default a failure is a failure.
  retries: Number(process.env.RASTRATA_PLAYWRIGHT_RETRIES ?? 0),
  workers: 3,
  reporter: "list",
  snapshotPathTemplate: "{testDir}/snapshots/{projectName}/{arg}{ext}",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    // The viewer's own clock and language, fixed: an instant is shown on a UTC clock, whatever machine
    // runs the suite. A test that wants another zone says so (`test.use({ timezoneId })`).
    timezoneId: "UTC",
    locale: "en-US",
  },
  projects: selected([
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // The story sweeps are long and run three to a browser; Firefox and WebKit have each missed one
    // element once in several clean runs, and a retry reports that as flaky instead of failing a landing.
    { name: "firefox", retries: 1, use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", retries: 1, use: { ...devices["Desktop Safari"] } },
  ]),
  webServer: {
    command: `bun --bun node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort --outDir dist/storybook`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
