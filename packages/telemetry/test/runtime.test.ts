import { afterEach, describe, expect, test } from "bun:test";
import { recordTelemetry } from "../src/testing.ts";
import {
  CpuAttribution,
  idleSeconds,
  startRuntimeTelemetry,
  threadCpuSeconds,
  trackPeakMemory,
  trackWork,
} from "../src/runtime.ts";

describe("CpuAttribution", () => {
  const clock = () => {
    let cpu = 0;
    return {
      now: () => cpu,
      burn: (seconds: number) => {
        cpu += seconds;
      },
    };
  };

  test("a request alone is given exactly the CPU that was used while it ran", () => {
    const cpu = clock();
    const meter = new CpuAttribution(cpu.now);
    cpu.burn(5); // before the request: nobody's
    const ticket = meter.begin();
    cpu.burn(0.25);
    expect(meter.end(ticket)).toBeCloseTo(0.25, 12);
    cpu.burn(3); // after: nobody's
    expect(ticket.cpu).toBeCloseTo(0.25, 12);
  });

  test("overlapping requests share the CPU, so nothing is counted twice", () => {
    const cpu = clock();
    const meter = new CpuAttribution(cpu.now);
    const a = meter.begin();
    cpu.burn(1); // a alone: 1
    const b = meter.begin();
    cpu.burn(2); // a and b: 1 each
    const c = meter.begin();
    cpu.burn(3); // a, b and c: 1 each
    expect(meter.end(a)).toBeCloseTo(3, 12);
    cpu.burn(2); // b and c: 1 each
    expect(meter.end(b)).toBeCloseTo(1 + 1 + 1, 12);
    cpu.burn(4); // c alone: 4
    expect(meter.end(c)).toBeCloseTo(1 + 1 + 4, 12);
    // Conservation: all the CPU used while anything was in flight is somebody's, once.
    expect(a.cpu + b.cpu + c.cpu).toBeCloseTo(1 + 2 + 3 + 2 + 4, 12);
    expect(meter.inFlight).toBe(0);
  });

  test("ending a request twice, or one that never began, changes nothing", () => {
    const cpu = clock();
    const meter = new CpuAttribution(cpu.now);
    const a = meter.begin();
    cpu.burn(1);
    meter.end(a);
    cpu.burn(1);
    meter.end(a);
    expect(a.cpu).toBeCloseTo(1, 12);
    meter.end({ cpu: 0 });
  });

  test("the real clock is the calling thread's CPU, which busy work moves and sleeping does not", async () => {
    // Busy work until the thread's clock has moved 40 ms, however busy the machine is (the tests run on every core at
    // once, so a thread gets less than all of a wall-clock moment): the clock moves, and never faster than time does.
    const before = threadCpuSeconds();
    const started = performance.now();
    let x = 0;
    while (threadCpuSeconds() - before < 0.04 && performance.now() - started < 5000)
      x += Math.sqrt(x + 1);
    const burnt = threadCpuSeconds() - before;
    const wall = (performance.now() - started) / 1000;
    expect(burnt).toBeGreaterThanOrEqual(0.04);
    expect(burnt).toBeLessThanOrEqual(wall + 0.01);
    const slept = threadCpuSeconds();
    await Bun.sleep(60);
    expect(threadCpuSeconds() - slept).toBeLessThan(0.02);
  });
});

describe("work and idleness", () => {
  let telemetry: ReturnType<typeof recordTelemetry> | undefined;
  afterEach(() => {
    telemetry?.stop();
    telemetry = undefined;
  });

  test("with telemetry off nothing is tracked", async () => {
    const done = trackWork();
    expect(done).toBe(trackWork());
    done();
    const peak = trackPeakMemory();
    expect(peak.stop()).toBe(0);
  });

  test("the process is not idle while something is in flight, and idle seconds grow after", async () => {
    telemetry = recordTelemetry();
    const first = trackWork();
    const second = trackWork();
    expect(idleSeconds()).toBe(0);
    first();
    first(); // twice is once
    expect(idleSeconds()).toBe(0);
    second();
    await Bun.sleep(60);
    expect(idleSeconds()).toBeGreaterThanOrEqual(0.05);
    const third = trackWork();
    expect(idleSeconds()).toBe(0);
    third();
  });

  test("peak memory sees what is allocated while it watches", async () => {
    telemetry = recordTelemetry();
    const peak = trackPeakMemory();
    const start = process.memoryUsage.rss();
    const held = new Uint8Array(120 * 1024 * 1024);
    held.fill(7); // touch the pages so they are resident
    await Bun.sleep(60);
    const high = peak.stop();
    expect(high - start).toBeGreaterThan(80 * 1024 * 1024);
    expect(held[0]).toBe(7);
  });
});

describe("the runtime sampler", () => {
  test("reports memory, cpu time, idle time and event-loop lag, and stops", async () => {
    const telemetry = recordTelemetry();
    let ticks = 0;
    const stop = startRuntimeTelemetry({
      sampleMs: 40,
      onTick: () => {
        ticks += 1;
      },
    });
    try {
      const until = performance.now() + 120;
      let x = 0;
      while (performance.now() < until) x += Math.sqrt(x + 1);
      await Bun.sleep(300);
      expect(ticks).toBeGreaterThanOrEqual(3);
      // A real figure, not the size of any one runtime: a process holds megabytes (Bun 1.4.3 starts under 10 MB).
      expect(telemetry.last("process.memory", { memory_kind: "rss" })).toBeGreaterThan(1_000_000);
      expect(telemetry.last("process.memory", { memory_kind: "heap_used" })).toBeGreaterThan(
        100_000,
      );
      expect(telemetry.sum("process.cpu.time", { cpu_mode: "user" })).toBeGreaterThan(0.05);
      expect(telemetry.last("process.idle.time")).toBeGreaterThanOrEqual(0);
      // The 100 ms timer ran a few times, and the busy stretch made one of them late.
      const lag = telemetry.stats("process.event_loop.lag");
      expect(lag.count).toBeGreaterThanOrEqual(2);
      expect(telemetry.invalid).toEqual([]);
    } finally {
      stop();
      telemetry.stop();
    }
    const after = ticks;
    await Bun.sleep(120);
    expect(ticks).toBe(after);
  });
});
