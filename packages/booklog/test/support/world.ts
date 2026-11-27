import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualClock } from "../../src/clock.ts";
import { MemoryObjectStore } from "../../src/memory.ts";
import { SimPodClock } from "../../src/podclock.ts";
import type { BookRuntimeOptions } from "../../src/runtime.ts";
import { MemoryLogTier } from "../../src/tier-memory.ts";

/** One book's storage in memory on a virtual clock, and a directory for the cache files of the
 * processes that serve it. Call `dispose()` (usually from `afterEach`) to remove the directory. */
export class World {
  readonly clock = new VirtualClock();
  readonly tier = new MemoryLogTier({ clock: this.clock });
  readonly bulk = new MemoryObjectStore({ clock: this.clock });
  readonly directory = mkdtempSync(join(tmpdir(), "booklog-world-"));

  constructor(readonly bookId = "b1") {}

  runtimeOptions(holder: string, file = "cache.sqlite"): BookRuntimeOptions {
    return {
      tier: this.tier,
      bulk: this.bulk,
      bookId: this.bookId,
      prefix: "runs/t/",
      holder,
      path: join(this.directory, file),
      schema: 1,
      clock: this.clock,
      pod: new SimPodClock(this.clock),
      sealing: { delayMs: 0 },
    };
  }

  sleep(ms: number) {
    return this.clock.drive(this.clock.sleep(ms));
  }

  dispose(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/** Worlds made during a test, removed together. */
export class Worlds {
  readonly #all: World[] = [];
  make(bookId = "b1"): World {
    const world = new World(bookId);
    this.#all.push(world);
    return world;
  }
  disposeAll(): void {
    for (const world of this.#all.splice(0)) world.dispose();
  }
}
