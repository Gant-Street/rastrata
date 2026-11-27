import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBookService } from "../src/local.ts";
import { chartState } from "../src/slices/chart/handlers.ts";
import { ingestRuntime } from "../src/slices/ingest/store.ts";
import { safetyRuntime } from "../src/safety/jobs.ts";
import { reconcileState } from "../src/slices/reconcile/state.ts";
import { rulesState } from "../src/slices/rules/store.ts";
import { nowOf } from "../src/slices/statements/ports.ts";
import { stripeRuntime } from "../src/slices/stripe/runtime.ts";
import { taxRuntime } from "../src/slices/tax/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

async function open(now?: () => Date): Promise<LocalBookService> {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-clock-"));
  const service = await LocalBookService.open(join(directory, "book.sqlite"), now ? { now } : {});
  cleanup.push(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return service;
}

test("a lane stamps with the service's clock, so one injected clock reaches every record (finding 11)", async () => {
  let ms = Date.UTC(2026, 3, 2, 12, 0, 0);
  const service = await open(() => new Date(ms));
  expect(service.now()).toBe("2026-04-02T12:00:00.000Z");
  const lanes: [string, () => string][] = [
    ["ingest", () => ingestRuntime(service).now()],
    ["rules", () => rulesState(service).now()],
    ["reconcile", () => reconcileState(service).now()],
    ["stripe", () => stripeRuntime(service).now()],
    ["chart", () => chartState(service).now()],
    ["tax", () => taxRuntime(service).now()],
    ["statements", () => nowOf(service).toISOString()],
    ["safety", () => safetyRuntime(service).now().toISOString()],
  ];
  for (const [lane, now] of lanes) expect(now(), lane).toBe("2026-04-02T12:00:00.000Z");
  // The clock moves and the lanes move with it; nothing was read once and kept.
  ms += 90_000;
  for (const [lane, now] of lanes) expect(now(), lane).toBe("2026-04-02T12:01:30.000Z");
  expect(rulesState(service).today()).toBe(service.today());
});

test("without an injected clock the lanes read the system clock, as they did", async () => {
  const service = await open();
  const before = Date.now();
  const stamped = Date.parse(ingestRuntime(service).now());
  expect(stamped).toBeGreaterThanOrEqual(before - 1);
  expect(stamped).toBeLessThanOrEqual(Date.now() + 1);
  expect(Math.abs(Date.parse(service.now()) - Date.now())).toBeLessThan(5_000);
});
