import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import {
  bucketOf,
  DEFAULT_MIX,
  journalsAt,
  meanJournals,
  planTenants,
  type SeedManifest,
} from "../bench/support/seed-plan.ts";

test("the default mix hits the charter's median, 90th and 99th percentile", () => {
  expect(journalsAt(DEFAULT_MIX, 0.5)).toBeCloseTo(2000, 6);
  expect(journalsAt(DEFAULT_MIX, 0.9)).toBeCloseTo(10000, 6);
  expect(journalsAt(DEFAULT_MIX, 0.99)).toBeCloseTo(30000, 6);
  expect(journalsAt(DEFAULT_MIX, 0)).toBeCloseTo(20, 6);
  expect(journalsAt(DEFAULT_MIX, 1)).toBeCloseTo(45000, 6);
  // Between two points the size is geometric, so it stays between them and rises with the quantile.
  let last = 0;
  for (let q = 0; q <= 1; q += 0.01) {
    const size = journalsAt(DEFAULT_MIX, q);
    expect(size).toBeGreaterThanOrEqual(last);
    last = size;
  }
  expect(meanJournals(DEFAULT_MIX)).toBeGreaterThan(3500);
  expect(meanJournals(DEFAULT_MIX)).toBeLessThan(5500);
});

test("size buckets are by journals and sit on the sizes the proof plan measures", () => {
  expect(bucketOf(499)).toBe("xs");
  expect(bucketOf(500)).toBe("s");
  expect(bucketOf(1999)).toBe("s");
  expect(bucketOf(2000)).toBe("m");
  expect(bucketOf(4999)).toBe("m");
  expect(bucketOf(5000)).toBe("l");
  expect(bucketOf(19999)).toBe("l");
  expect(bucketOf(20000)).toBe("xl");
});

test("a plan is the same every time, plants one huge tenant, and covers the spread", () => {
  const first = planTenants({ tenants: 20, seed: 7 });
  const again = planTenants({ tenants: 20, seed: 7 });
  expect(first).toEqual(again);
  expect(planTenants({ tenants: 20, seed: 8 })).not.toEqual(first);
  expect(first).toHaveLength(20);
  expect(first.filter((tenant) => tenant.huge)).toHaveLength(1);
  expect(first[0]?.huge).toBe(true);
  expect(first[0]?.journals).toBeCloseTo(30000, -1);
  // Ids are what a store can key a book by.
  for (const tenant of first) expect(tenant.tenantId).toMatch(/^t-[0-9]{6}$/);
  expect(new Set(first.map((tenant) => tenant.tenantId)).size).toBe(20);
  // Evenly spaced quantiles: the others reach from a tiny book to a large one, in every bucket but the top.
  const buckets = new Set(first.map((tenant) => tenant.bucket));
  for (const bucket of ["xs", "s", "m", "l"]) expect(buckets.has(bucket as never)).toBe(true);
  // The order says nothing about size: it is not sorted.
  const sizes = first.slice(1).map((tenant) => tenant.journals);
  expect(sizes).not.toEqual([...sizes].sort((a, b) => a - b));
  // Charts and revisions vary and grow with the book.
  const small = first.filter((tenant) => tenant.journals < 500);
  const large = first.filter((tenant) => tenant.journals > 5000 && !tenant.huge);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  expect(mean(large.map((tenant) => tenant.accounts))).toBeGreaterThan(
    mean(small.map((tenant) => tenant.accounts)),
  );
  expect(new Set(first.map((tenant) => tenant.revisions)).size).toBeGreaterThan(3);
});

test("scale shrinks every size, the cap holds, and a ladder adds exact sizes after the mix", () => {
  const scaled = planTenants({ tenants: 10, scale: 0.1, seed: 1 });
  const full = planTenants({ tenants: 10, scale: 1, seed: 1 });
  expect(scaled.reduce((sum, tenant) => sum + tenant.journals, 0)).toBeLessThan(
    full.reduce((sum, tenant) => sum + tenant.journals, 0) / 5,
  );
  const capped = planTenants({ tenants: 10, maxJournals: 1000, seed: 1 });
  for (const tenant of capped) expect(tenant.journals).toBeLessThanOrEqual(1000);
  const ladder = planTenants({
    tenants: 3,
    scale: 0.01,
    ladder: [500, 2000, 5000, 20000],
    seed: 1,
  });
  expect(ladder).toHaveLength(7);
  const rungs = ladder.filter((tenant) => tenant.ladder !== null);
  expect(rungs.map((tenant) => tenant.journals)).toEqual([500, 2000, 5000, 20000]);
  expect(rungs.map((tenant) => tenant.bucket)).toEqual(["s", "m", "l", "xl"]);
  for (const rung of rungs) {
    expect(rung.accounts).toBe(100);
    expect(rung.revisions).toBe(10);
  }
  expect(ladder.slice(0, 3).every((tenant) => tenant.ladder === null)).toBe(true);
  expect(() => planTenants({ tenants: 0 })).toThrow();
});

test("the seeder makes books that open, carry a token that works, and a manifest that says what they are", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-seed-test-"));
  try {
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../bench/seed-books.ts"),
        "--out",
        directory,
        "--tenants",
        "2",
        "--scale",
        "0.002",
        "--ladder",
        "30",
        "--jobs",
        "1",
        "--seed",
        "3",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const manifest = JSON.parse(
      await Bun.file(join(directory, "manifest.json")).text(),
    ) as SeedManifest;
    expect(manifest.format).toBe("rastrata-seed-manifest-v1");
    expect(manifest.tenants).toHaveLength(3);
    expect(manifest.totals.tenants).toBe(3);
    expect(manifest.tenants.filter((tenant) => tenant.ladder === 30)).toHaveLength(1);
    // Credentials never leave the directory: it ignores itself, and the manifest is private.
    expect(await Bun.file(join(directory, ".gitignore")).text()).toBe("*\n");
    const tenant = manifest.tenants[2];
    expect(tenant?.journals).toBe(30);
    expect(tenant?.token).toMatch(/^rst_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(tenant?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The book opens, has the journals the plan said, and the token reads it through the real boundary.
    const service = await LocalBookService.open(join(directory, tenant?.file ?? ""), {
      safety: false,
      snapshots: false,
    });
    try {
      const http = new ApplicationHttp(service, {
        bookId: service.bookId,
        permissions: BUSINESS_PERMISSIONS,
      });
      const ask = async (name: string, authorization?: string) => {
        const response = await http.fetch(
          new Request(`http://127.0.0.1:4010/v1/${name}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
            },
            body: JSON.stringify({
              version: APPLICATION_API_VERSION,
              bookId: service.bookId,
              input: { asOf: "2026-12-31", from: "2026-01-01" },
            }),
          }),
        );
        return (await response.json()) as { ok: boolean; data?: { bookRevision: string } };
      };
      const report = await ask("reports.get", tenant?.token);
      expect(report.ok).toBe(true);
      expect((await service.readAggregate()).aggregate.state.journals).toHaveLength(30);
    } finally {
      service.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
