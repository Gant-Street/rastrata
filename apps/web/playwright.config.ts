import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An instant is shown on the viewer's own clock, so a test needs its viewer to be somewhere known: the
// browser is in UTC (timezoneId below) and so is this process and the workers it starts, which is what
// `shown.instant` in tests/support assumes. One test names another zone (`test.use({ timezoneId })`).
process.env.TZ = "UTC";

const localBrowserData = mkdtempSync(join(tmpdir(), "rastrata-web-browser-"));
// Lanes (and landings) running on one machine each set RASTRATA_PORT_OFFSET, a multiple of 100.
// Every run's servers live in a block of 100 ports of its own, 20000 + offset, so two runs can
// never share a port. The numbers passed to port() below are only names: each distinct one takes
// the next free slot in the block (0 to 59; the UI and marketing configs use 60 and up), so two
// servers of one run cannot share a port either. Unset means offset 0, main's block.
const offset = Number(process.env.RASTRATA_PORT_OFFSET ?? "0");
if (!Number.isInteger(offset) || offset < 0 || offset > 5000 || offset % 100 !== 0)
  throw new Error("RASTRATA_PORT_OFFSET must be a multiple of 100 from 0 to 5000");
const slots = new Map<number, number>();
const port = (name: number) => {
  let slot = slots.get(name);
  if (slot === undefined) {
    slot = slots.size;
    if (slot >= 60) throw new Error("apps/web needs more than 60 server ports; widen the block");
    slots.set(name, slot);
  }
  return 20_000 + offset + slot;
};
// The servers these tests start inherit this environment. Automatic backups (safety lane) are for a
// real book: a throwaway test book is not backed up in the background.
process.env.RASTRATA_BACKUPS = "off";
// Stripe lane: the key is made up (never a real one) and assembled here so no key-shaped literal
// is in the repository. The service reads it from its environment; the stand-in Stripe accepts it.
const stripeKey = ["rk", "test", "BrowserFlowStandInKey000000"].join("_");
// Lane landings run one browser (RASTRATA_PLAYWRIGHT_PROJECTS=chromium); main runs all three.
const only = (process.env.RASTRATA_PLAYWRIGHT_PROJECTS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const selected = <T extends { name: string }>(projects: T[]): T[] =>
  only.length === 0
    ? projects
    : projects.filter((project) => only.some((name) => project.name.includes(name)));

const config = defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: true,
  // See packages/ui/playwright.config.ts: a lane's landing retries a failed test once, because the computer is shared; everywhere else a failure is a failure.
  retries: Number(process.env.RASTRATA_PLAYWRIGHT_RETRIES ?? 0),
  workers: 3,
  reporter: "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The viewer's own clock and language, fixed: dates read "Mar 20, 2026" and an instant is shown on
    // a UTC clock, whatever machine runs the suite.
    timezoneId: "UTC",
    locale: "en-US",
  },
  projects: selected([
    // The shell on the build that ships, in the three engines. The development server is a developer's tool: its
    // refresh is checked by development-refresh, and the rest would be the same tests again.
    {
      name: "production-chromium",
      testMatch: "smoke.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4181)}` },
    },
    {
      name: "production-firefox",
      testMatch: "smoke.spec.ts",
      use: { ...devices["Desktop Firefox"], baseURL: `http://127.0.0.1:${port(4181)}` },
    },
    {
      name: "production-webkit",
      testMatch: "smoke.spec.ts",
      // The Ark combobox in WebKit sometimes closes its list while typing settles (about one run
      // in twenty, with or without load). A retry reports it as flaky instead of failing the run.
      retries: 2,
      use: { ...devices["Desktop Safari"], baseURL: `http://127.0.0.1:${port(4181)}` },
    },
    // Help: the list and the reader on the build that ships (its topics are files the build writes). It reads
    // and writes nothing of a book, so it shares the preview server with the smoke test; one browser.
    {
      name: "help-chromium",
      testMatch: "help.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4181)}` },
    },
    ...["chromium", "firefox", "webkit"].map((browser, index) => ({
      name: `local-${browser}`,
      testMatch: "local-book.spec.ts",
      use: {
        ...devices[
          browser === "chromium"
            ? "Desktop Chrome"
            : browser === "firefox"
              ? "Desktop Firefox"
              : "Desktop Safari"
        ],
        baseURL: `http://127.0.0.1:${port(4190 + index)}`,
      },
    })),
    // The chart lane's setup wizard needs a book that does not exist yet, so it has its own servers.
    ...["chromium", "firefox", "webkit"].map((browser, index) => ({
      name: `chart-${browser}`,
      testMatch: "chart-setup.spec.ts",
      use: {
        ...devices[
          browser === "chromium"
            ? "Desktop Chrome"
            : browser === "firefox"
              ? "Desktop Firefox"
              : "Desktop Safari"
        ],
        baseURL: `http://127.0.0.1:${port(4200 + index)}`,
      },
    })),
    {
      name: "development-refresh",
      testMatch: "refresh.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    // Reports lane: one fresh book of its own (its tests are serial), one browser.
    {
      name: "reports-chromium",
      testMatch: "reports.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4720)}` },
    },
    // Reconcile lane: one fresh book of its own (its tests are serial), one browser. The full
    // three-browser matrix is run by main.
    // Inbox (ingest lane): one fresh book of its own, serial tests, one browser.
    {
      name: "inbox-chromium",
      testMatch: "inbox.spec.ts",
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4700)}` },
    },
    {
      name: "reconcile-chromium",
      testMatch: "reconcile.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4620)}` },
    },
    // Stripe lane: one fresh book of its own (the tests are serial), a made-up key, and a stand-in
    // Stripe on this machine; one browser. The full three-browser matrix is run by main.
    {
      name: "stripe-chromium",
      testMatch: "stripe.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4640)}` },
    },
    // Agent lane: the Agent access screen against a service with the owner lock on (the web server
    // acts for the owner with the key), serial tests on a book of its own, one browser. main runs the
    // full matrix elsewhere. The service's own address is in the project's metadata, for the calls
    // that must reach it directly (a caller with no credentials is refused there, and not by the web
    // server, which would add the key).
    {
      name: "agent-chromium",
      testMatch: "agent-access.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4940)}` },
      metadata: { api: `http://127.0.0.1:${port(4941)}` },
    },
    // Statements lane: one book shared by the three browsers, each importing into accounts of its
    // own (the tests in a browser are serial).
    ...(["chromium", "firefox", "webkit"] as const).map((browser) => ({
      name: `import-${browser}`,
      testMatch: "import.spec.ts",
      use: {
        ...devices[
          browser === "chromium"
            ? "Desktop Chrome"
            : browser === "firefox"
              ? "Desktop Firefox"
              : "Desktop Safari"
        ],
        baseURL: `http://127.0.0.1:${port(4660)}`,
      },
    })),
    // Rules lane: one fresh book of its own (its tests are serial), one browser. The full
    // three-browser matrix is run by main.
    {
      name: "rules-chromium",
      testMatch: "rules.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4830)}` },
    },
    // Safety lane: one fresh book of its own (its tests are serial), one browser. Its API server
    // answers a long job's first ask at once ("running"), so the page's polling is what the test
    // exercises. The full three-browser matrix is run by main.
    {
      name: "safety-chromium",
      testMatch: "safety.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4770)}` },
    },
    // Shadow lane (the move from another system): one fresh book of its own (its tests are
    // serial), one browser. The full three-browser matrix is run by main.
    {
      name: "shadow-chromium",
      testMatch: "shadow.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4800)}` },
    },
    // Bank feed lane: one fresh book of its own (its tests are serial), a stand-in SimpleFIN Bridge on
    // this machine and a service that may speak to that one address; one browser. The full
    // three-browser matrix is run by main.
    {
      name: "bankfeed-chromium",
      testMatch: "bankfeed.spec.ts",
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4950)}` },
    },
    // Acceptance (the founder's first month through the screens): one fresh book of its own, one
    // long serial story, one browser. The ports (4910, 4911) are distinct modulo 100 from every
    // other base port here, so no lane's offset can make two servers collide.
    {
      name: "first-month-chromium",
      testMatch: "first-month.spec.ts",
      timeout: 240_000,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${port(4910)}`,
        actionTimeout: 20_000,
      },
    },
    // Calendar lane: one fresh book of its own (its tests are serial), one browser. The full
    // three-browser matrix is run by main.
    {
      name: "calendar-chromium",
      testMatch: "calendar.spec.ts",
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4740)}` },
    },
    // Settings: the fiscal year is changed until the first entry. A fresh book made through the setup
    // (it needs a book that does not exist yet), one browser.
    {
      name: "year-start-chromium",
      testMatch: "year-start.spec.ts",
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(5300)}` },
    },
    // Settings: a file of entries is previewed and imported. A fresh book made through the setup (the
    // import adds accounts, which a book with entries cannot take), one browser.
    {
      name: "history-chromium",
      testMatch: "history.spec.ts",
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(5400)}` },
    },
    // Accounting lane (UX program): the Transactions list, an entry and reversing it, on a book of its
    // own seeded through the API (its tests are serial), one browser. The full matrix is run by main.
    {
      name: "accounting-chromium",
      testMatch: "accounting.spec.ts",
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4980)}` },
    },
    // Tax lane: one fresh book of its own (its tests are serial), one browser. The full three-browser
    // matrix is run by main.
    {
      name: "tax-chromium",
      testMatch: "tax.spec.ts",
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4757)}` },
    },
    // Payees lane: Money by payee and the naming of a payee, on one fresh book of its own (its tests are
    // serial), one browser. The full three-browser matrix is run by main.
    {
      name: "payees-chromium",
      testMatch: "payees.spec.ts",
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4990)}` },
    },
    // The UX ratchet (ux-guards.spec.ts): every route at 1440 by 800 against a book that has something in it,
    // held to the program's rules for work before explanation and for no machine detail. One fresh book of
    // its own (the tests are serial), one browser.
    {
      name: "ux-guards-chromium",
      testMatch: "ux-guards.spec.ts",
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4960)}` },
    },
    // Entries lane (Spend money, Receive money, Transfer, Undo and the Business settings): one fresh book of
    // its own (its tests are serial), one browser. The full three-browser matrix is run by main.
    {
      name: "entries-chromium",
      testMatch: "entries.spec.ts",
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(4970)}` },
    },
    // Catchall (money collecting in an account for what fits nowhere else, and changing the account of
    // transactions that came from For review): one fresh book of its own, serial tests, one browser.
    {
      name: "catchall-chromium",
      testMatch: "catchall.spec.ts",
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port(5010)}` },
    },
    // Accounts: the whole product on this computer (apps/control-worker/tooling/dev-stack.ts: the pod with accounts and many books, the control Worker
    // under workerd, the built web app, one address). The spec starts it itself on a port the system chooses, so it needs no entry in webServer below and no
    // port of its own. The address is https with a certificate made for the run (`--tls`), because the cookies are `Secure` and only Chromium keeps one from plain http on a
    // loopback address; each browser is told to accept the certificate.
    ...(["chromium", "firefox", "webkit"] as const).map((browser) => ({
      name: `accounts-${browser}`,
      testMatch: "accounts.spec.ts",
      timeout: 120_000,
      use: {
        ...devices[
          browser === "chromium"
            ? "Desktop Chrome"
            : browser === "firefox"
              ? "Desktop Firefox"
              : "Desktop Safari"
        ],
        ignoreHTTPSErrors: true,
      },
    })),
    // Stripe connected with the button: the whole product on this computer with stand-ins for Stripe (dev-stack.ts with --stripe-app: a page that plays the app's install page, and a fake Stripe).
    // The spec starts it itself on a port the system chooses, like accounts above, and for the same reason it is served over https.
    ...(["chromium", "firefox", "webkit"] as const).map((browser) => ({
      name: `stripe-app-${browser}`,
      testMatch: "stripe-app.spec.ts",
      timeout: 120_000,
      use: {
        ...devices[
          browser === "chromium"
            ? "Desktop Chrome"
            : browser === "firefox"
              ? "Desktop Firefox"
              : "Desktop Safari"
        ],
        ignoreHTTPSErrors: true,
      },
    })),
    // Install lane: the compiled installed service (the app and the API in one process, locked, with a
    // content policy). The spec builds and starts it itself on a port the system chooses, so it needs
    // no entry in webServer below and no port of its own.
    ...(["chromium", "firefox", "webkit"] as const).map((browser) => ({
      name: `installed-${browser}`,
      testMatch: "installed.spec.ts",
      timeout: 120_000,
      use: {
        ...devices[
          browser === "chromium"
            ? "Desktop Chrome"
            : browser === "firefox"
              ? "Desktop Firefox"
              : "Desktop Safari"
        ],
      },
    })),
  ]),
  webServer: [
    ...["chromium", "firefox", "webkit"].map((browser, index) => ({
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4250 + index)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4250 + index)),
        RASTRATA_LOCAL_DB: join(localBrowserData, `${browser}.sqlite`),
      },
      reuseExistingServer: false,
    })),
    ...["chromium", "firefox", "webkit"].map((browser, index) => ({
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4190 + index)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4190 + index)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4250 + index)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, `${browser}.sqlite`),
      },
      reuseExistingServer: false,
    })),
    ...["chromium", "firefox", "webkit"].map((browser, index) => ({
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4260 + index)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4260 + index)),
        RASTRATA_LOCAL_DB: join(localBrowserData, `chart-${browser}.sqlite`),
      },
      reuseExistingServer: false,
    })),
    ...["chromium", "firefox", "webkit"].map((browser, index) => ({
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4200 + index)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4200 + index)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4260 + index)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, `chart-${browser}.sqlite`),
      },
      reuseExistingServer: false,
    })),
    // Agent lane: the Agent access screen runs against a service with the owner lock on; the web
    // server acts for the owner with the key.
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4941)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4941)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "agent.sqlite"),
        RASTRATA_OWNER_KEY_FILE: join(localBrowserData, "agent-owner.key"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4940)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4940)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4941)}`,
        RASTRATA_OWNER_KEY_FILE: join(localBrowserData, "agent-owner.key"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4971)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4971)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "entries.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4970)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4970)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4971)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "entries.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/preview.ts",
      url: `http://127.0.0.1:${port(4181)}`,
      env: { PORT: String(port(4181)) },
      reuseExistingServer: false,
    },
    // The Inbox's own book is also given the Stripe lane's stand-in Stripe (and a made-up key), so a
    // payout and the lines it books can be seen on the Inbox screen as the Stripe lane produces them.
    {
      command: "bun ../../packages/application/test/stripe/serve-fake-stripe.ts",
      url: `http://127.0.0.1:${port(4702)}`,
      env: {
        RASTRATA_FAKE_STRIPE_PORT: String(port(4702)),
        RASTRATA_FAKE_STRIPE_KEY: stripeKey,
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4701)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4701)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "inbox.sqlite"),
        RASTRATA_STRIPE_KEY: stripeKey,
        RASTRATA_STRIPE_API_URL: `http://127.0.0.1:${port(4702)}`,
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4700)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4700)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4701)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "inbox.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4621)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4621)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "reconcile.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4620)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4620)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4621)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "reconcile.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../../packages/application/test/stripe/serve-fake-stripe.ts",
      // The stand-in answers 401 to a request without the key, which means it is up.
      url: `http://127.0.0.1:${port(4642)}`,
      env: {
        RASTRATA_FAKE_STRIPE_PORT: String(port(4642)),
        RASTRATA_FAKE_STRIPE_KEY: stripeKey,
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4641)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4641)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "stripe.sqlite"),
        RASTRATA_STRIPE_KEY: stripeKey,
        RASTRATA_STRIPE_API_URL: `http://127.0.0.1:${port(4642)}`,
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4640)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4640)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4641)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "stripe.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4721)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4721)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "reports.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4720)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4720)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4721)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "reports.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4661)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4661)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "import.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4660)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4660)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4661)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "import.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4831)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4831)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "rules.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4830)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4830)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4831)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "rules.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4771)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4771)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "safety.sqlite"),
        RASTRATA_SAFETY_WAIT_MS: "0",
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4801)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4801)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "shadow.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4741)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4741)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "calendar.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4770)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4770)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4771)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "safety.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4800)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4800)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4801)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "shadow.sqlite"),
      },
      reuseExistingServer: false,
    },
    // The bank feed's stand-in Bridge (a fictional September, made-up credentials). It answers its
    // control route with 200, which means it is up. The service is told the one address it may speak
    // to over http. Its own bank feed timer is left out (RASTRATA_BANKFEED=off): the daily sync's timer
    // is tested with an injected clock, and a timer that fires during a browser test would be a sync
    // nobody asked for. Its book lives in a folder of its own, because the bank connection is a file
    // beside the book and no other project's book should see it.
    {
      command: "bun ../../packages/application/test/bankfeed/serve-fake-simplefin.ts",
      url: `http://127.0.0.1:${port(4952)}/__fake/token`,
      env: { RASTRATA_FAKE_SIMPLEFIN_PORT: String(port(4952)) },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4951)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4951)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "bankfeed", "book.sqlite"),
        RASTRATA_SIMPLEFIN_STANDIN: `http://127.0.0.1:${port(4952)}`,
        RASTRATA_BANKFEED: "off",
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4950)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4950)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4951)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "bankfeed", "book.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4911)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4911)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "first-month.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4910)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4910)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4911)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "first-month.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(5401)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(5401)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "history.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(5400)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(5400)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(5401)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "history.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(5301)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(5301)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "year-start.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(5300)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(5300)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(5301)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "year-start.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4740)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4740)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4741)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "calendar.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4981)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4981)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "accounting.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4980)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4980)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4981)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "accounting.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4758)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4758)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "tax.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4757)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4757)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4758)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "tax.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4991)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4991)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "payees.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4990)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4990)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4991)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "payees.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(4961)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(4961)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "ux-guards.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(4960)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(4960)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(4961)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "ux-guards.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun ../api/src/main.ts",
      url: `http://127.0.0.1:${port(5011)}/health`,
      env: {
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port(5011)),
        RASTRATA_LOCAL_DB: join(localBrowserData, "catchall.sqlite"),
      },
      reuseExistingServer: false,
    },
    {
      command: "bun tooling/dev.ts",
      url: `http://127.0.0.1:${port(5010)}`,
      env: {
        RASTRATA_WEB_HMR: "0",
        PORT: String(port(5010)),
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_URL: `http://127.0.0.1:${port(5011)}`,
        RASTRATA_LOCAL_DB: join(localBrowserData, "catchall.sqlite"),
      },
      reuseExistingServer: false,
    },
  ],
});

// The bank feed browser test drives the stand-in Bridge's control routes (it adds an account, makes the
// Bridge complain), so it is told where the Bridge is.
process.env.RASTRATA_FAKE_SIMPLEFIN_URL = `http://127.0.0.1:${port(4952)}`;

// Every project's baseURL names a server, and a server names the servers it talks to in its
// environment (its API, a stand-in Stripe). Only the servers the projects that will run can reach
// are started: each one is a process of its own, and the whole set is several gigabytes, which is
// what a run of a single spec used to pay for. The projects that run are those left by
// RASTRATA_PLAYWRIGHT_PROJECTS and then by --project on the command line.
const portOf = (text: string | undefined): number | undefined => {
  const match = /^https?:\/\/[^/:]+:(\d+)/.exec(text ?? "");
  return match ? Number(match[1]) : undefined;
};
const commandLineProjects = (): RegExp[] => {
  const patterns: string[] = [];
  const args = process.argv;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if ((arg === "--project" || arg === "-p") && args[index + 1])
      patterns.push(args[index + 1] ?? "");
    else if (arg.startsWith("--project=")) patterns.push(arg.slice("--project=".length));
  }
  return patterns.map(
    (pattern) =>
      new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i"),
  );
};
type Server = Exclude<NonNullable<typeof config.webServer>, unknown[]>;
function neededServers(settings: typeof config): Server[] {
  const servers: Server[] = [settings.webServer ?? []].flat();
  const wanted = commandLineProjects();
  const running = (settings.projects ?? []).filter(
    (project) => wanted.length === 0 || wanted.some((pattern) => pattern.test(project.name ?? "")),
  );
  const needed = new Set<number>();
  for (const project of running) {
    const port = portOf(project.use?.baseURL);
    if (port !== undefined) needed.add(port);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const server of servers) {
      const own = portOf(server.url);
      if (own === undefined || !needed.has(own)) continue;
      for (const value of Object.values(server.env ?? {}))
        for (const match of String(value).matchAll(/:\/\/[^/:]+:(\d+)/g)) {
          const port = Number(match[1]);
          if (!needed.has(port)) {
            needed.add(port);
            changed = true;
          }
        }
    }
  }
  return servers.filter((server) => needed.has(portOf(server.url) ?? -1));
}

export default { ...config, webServer: neededServers(config) } satisfies typeof config;
