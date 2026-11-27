import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { R2ArchiveObjectStore, type ArchiveR2Bucket } from "../src/r2-archive-store.ts";
import { LEDGER_LIMITS } from "../src/records.ts";
import { withBucket } from "./r2-fixtures.ts";

const scope = {
  tenantId: "tenant",
  bookId: "book",
  objectId: "object",
  namespaceId: "archive-test",
  generation: "0",
};
const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

test("R2 archive adapter runs inside workerd against native binary body streams and conditional writes", async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./runtime-archive-worker.ts", import.meta.url).pathname],
    target: "node",
    format: "esm",
    external: ["node:crypto"],
  });
  expect(build.success).toBe(true);
  const output = build.outputs[0];
  if (output === undefined) throw new Error("Missing archive worker bundle");
  const directory = mkdtempSync(join(tmpdir(), "rastrata-r2-transport-"));
  const options = {
    modules: true,
    script: await output.text(),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    r2Buckets: ["ARCHIVE"],
    r2Persist: directory,
    cf: false,
  };
  let runtime = new Miniflare(options);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await runtime.dispatchFetch("http://archive.test/");
      const body = await response.text();
      if (!response.ok) throw new Error(body);
      const result = JSON.parse(body);
      expect(result).toMatchObject({
        data: [0, 255, 128, 1, 13, 10],
        winners: 1,
        returned: "written",
        late: "conflict",
        head: "first",
      });
      await runtime.dispose();
      runtime = new Miniflare(options);
      // Read before any PUT in the new runtime, so a re-upload cannot conceal loss.
      const restored = await runtime.dispatchFetch("http://archive.test/read", {
        method: "POST",
        body: JSON.stringify(result.reference),
      });
      expect(restored.status).toBe(200);
      expect(await restored.json()).toEqual({
        data: [0, 255, 128, 1, 13, 10],
        control: result.control,
      });
    }
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("R2 archive transport verifies immutable bytes, snapshots input and never repairs corrupt objects", async () => {
  await withBucket(async (bucket) => {
    const store = new R2ArchiveObjectStore(bucket, scope, "object");
    const input = bytes("exact λ payload");
    const pending = store.putImmutable(input);
    input.fill(0);
    const reference = await pending;
    expect(text(await store.readImmutable(reference))).toBe("exact λ payload");
    expect(reference.payloadBytes).toBe(16);
    expect(await store.readControl()).toBeNull();
    const retries = await Promise.all([
      store.putImmutable(bytes("exact λ payload")),
      store.putImmutable(bytes("exact λ payload")),
    ]);
    expect(retries).toEqual([reference, reference]);
    expect(await store.readImmutable(await store.putImmutable(new Uint8Array()))).toEqual(
      new Uint8Array(),
    );
    await bucket.put(reference.objectKey, bytes("corrupt λ bytes"));
    await expect(store.readImmutable(reference)).rejects.toThrow();
    await expect(store.putImmutable(bytes("exact λ payload"))).rejects.toThrow();
    expect(await (await bucket.get(reference.objectKey))?.text()).toBe("corrupt λ bytes");
  });
});

test("R2 archive transport binds immutable references and control envelopes to complete book identity", async () => {
  await withBucket(async (bucket) => {
    const store = new R2ArchiveObjectStore(bucket, scope, "object");
    const reference = await store.putImmutable(bytes("same bytes"));
    for (const changed of [
      { ...scope, bookId: "other" },
      { ...scope, tenantId: "other" },
      { ...scope, namespaceId: "other" },
      { ...scope, generation: "1" },
    ]) {
      const other = new R2ArchiveObjectStore(bucket, changed, "object");
      await expect(other.readImmutable(reference)).rejects.toThrow("archive_invalid_reference");
      const distinct = await other.putImmutable(bytes("same bytes"));
      expect(distinct.objectKey).not.toBe(reference.objectKey);
      expect(distinct.payloadHash).toBe(reference.payloadHash);
      expect(await other.readControl()).toBeNull();
    }
    expect(() => new R2ArchiveObjectStore(bucket, scope, "wrong-object")).toThrow(
      "ledger_identity_mismatch",
    );
  });
});

test("R2 archive transport has one CAS winner, checks full expected bytes and prevents adapter ABA", async () => {
  await withBucket(async (bucket) => {
    const store = new R2ArchiveObjectStore(bucket, scope, "object");
    const created = await store.compareAndSwapControl(null, "A");
    if (created.disposition !== "written") throw new Error("Missing initial control");
    expect(await store.compareAndSwapControl(null, "overwrite")).toEqual({
      disposition: "conflict",
    });
    expect(
      await store.compareAndSwapControl({ ...created.version, body: "wrong head" }, "bad"),
    ).toEqual({ disposition: "conflict" });
    const results = await Promise.all(
      ["B", "C"].map((body) => store.compareAndSwapControl(created.version, body)),
    );
    expect(results.filter((result) => result.disposition === "written")).toHaveLength(1);
    const winner = results.find((result) => result.disposition === "written");
    if (winner?.disposition !== "written") throw new Error("Missing winner");
    expect(await store.readControl()).toEqual(winner.version);
    const back = await store.compareAndSwapControl(winner.version, "A");
    if (back.disposition !== "written") throw new Error("Missing return to A");
    expect(back.version.storageRevision).not.toBe(created.version.storageRevision);
    expect(back.version.nonce).not.toBe(created.version.nonce);
    expect(await store.compareAndSwapControl(created.version, "late publisher")).toEqual({
      disposition: "conflict",
    });
    const same = await store.compareAndSwapControl(back.version, "A");
    if (same.disposition !== "written") throw new Error("Missing same-body write");
    expect(same.version.storageRevision).not.toBe(back.version.storageRevision);
    expect(await store.readControl()).toEqual(same.version);
  });
});

test("R2 archive transport reports lost PUT replies as uncertain and preserves the stored candidate", async () => {
  await withBucket(async (bucket) => {
    let loseReply = true;
    const faulty: ArchiveR2Bucket = {
      get: (key) => bucket.get(key),
      async put(key, value, options) {
        const result = await bucket.put(key, value, options);
        if (loseReply) {
          loseReply = false;
          throw new Error("Injected reply loss after actual local R2 PUT");
        }
        return result;
      },
    };
    const store = new R2ArchiveObjectStore(faulty, scope, "object");
    await expect(store.putImmutable(bytes("selected payload"))).rejects.toThrow(
      "archive_write_uncertain",
    );
    const reference = await store.putImmutable(bytes("selected payload"));
    expect(text(await store.readImmutable(reference))).toBe("selected payload");
    loseReply = true;
    await expect(store.compareAndSwapControl(null, "selected rejected outcome")).rejects.toThrow(
      "archive_write_uncertain",
    );
    const stored = await store.readControl();
    expect(stored?.body).toBe("selected rejected outcome");
    expect(await store.compareAndSwapControl(null, "different outcome")).toEqual({
      disposition: "conflict",
    });
    expect(await store.readControl()).toEqual(stored);
  });
});

test("R2 archive transport rejects invalid inputs before I/O and enforces complete UTF-8 envelope bounds", async () => {
  let calls = 0;
  const unavailable: ArchiveR2Bucket = {
    async get() {
      calls++;
      throw new Error("Unexpected read");
    },
    async put() {
      calls++;
      throw new Error("Unexpected write");
    },
  };
  const store = new R2ArchiveObjectStore(unavailable, scope, "object");
  await expect(store.putImmutable(new Uint8Array(LEDGER_LIMITS.recordBytes + 1))).rejects.toThrow(
    "archive_invalid_input",
  );
  await expect(
    store.compareAndSwapControl(null, "λ".repeat(LEDGER_LIMITS.recordBytes / 2)),
  ).rejects.toThrow("archive_invalid_input");
  await expect(
    store.readImmutable({ objectKey: "outside", payloadHash: "f".repeat(64), payloadBytes: 1 }),
  ).rejects.toThrow("archive_invalid_reference");
  await expect(
    store.compareAndSwapControl({ body: "old", storageRevision: "", nonce: "bad" }, "next"),
  ).rejects.toThrow("archive_invalid_input");
  let getterRead = false;
  const hostile = {
    get objectKey() {
      getterRead = true;
      return "key";
    },
    payloadHash: "f".repeat(64),
    payloadBytes: 1,
  };
  await expect(store.readImmutable(hostile)).rejects.toThrow("archive_invalid_input");
  expect(getterRead).toBe(false);
  expect(calls).toBe(0);
});

test("R2 archive transport detects missing, wrong-sized, corrupt and overlong streamed payloads", async () => {
  await withBucket(async (bucket) => {
    const clean = new R2ArchiveObjectStore(bucket, scope, "object");
    const reference = await clean.putImmutable(bytes("1234"));
    let mode = "missing",
      cancelled = false;
    const faulty: ArchiveR2Bucket = {
      put: (key, value, options) => bucket.put(key, value, options),
      async get(key) {
        if (mode === "missing") return null;
        const actual = await bucket.get(key);
        if (actual === null) throw new Error("Missing real source");
        await actual.body.cancel();
        const data =
          mode === "short" ? bytes("123") : mode === "long" ? bytes("12345") : bytes("xxxx");
        return {
          key,
          etag: actual.etag,
          size: mode === "metadata" ? LEDGER_LIMITS.recordBytes + 1 : 4,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(data);
              if (mode !== "long") controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
        };
      },
    };
    const store = new R2ArchiveObjectStore(faulty, scope, "object");
    for (const [kind, diagnostic] of [
      ["missing", "archive_payload_missing"],
      ["metadata", "archive_object_metadata_mismatch"],
      ["short", "archive_object_size_mismatch"],
      ["long", "archive_object_size_mismatch"],
      ["hash", "archive_payload_hash_mismatch"],
    ] as const) {
      mode = kind;
      await expect(store.readImmutable(reference)).rejects.toThrow(diagnostic);
    }
    expect(cancelled).toBe(true);
    expect(text(await clean.readImmutable(reference))).toBe("1234");
  });
});

test("R2 archive transport refuses corrupt or cross-scope control envelopes without overwriting", async () => {
  await withBucket(async (bucket) => {
    const store = new R2ArchiveObjectStore(bucket, scope, "object");
    const payload = await store.putImmutable(bytes("locator"));
    const key = `${payload.objectKey.split("/immutable/")[0]}/control/anchor`;
    const created = await store.compareAndSwapControl(null, "head");
    if (created.disposition !== "written") throw new Error("Missing control");
    const original = await (await bucket.get(key))?.text();
    if (original === undefined) throw new Error("Missing envelope");
    for (const corrupted of [
      "not json",
      ` ${original}`,
      original.replace('"version":', '"extra":1,"version":'),
      original.replace(/"scopeHash":"[0-9a-f]+"/, '"scopeHash":"wrong"'),
    ]) {
      await bucket.put(key, corrupted);
      await expect(store.readControl()).rejects.toThrow();
      expect(await store.compareAndSwapControl(null, "repair")).toEqual({
        disposition: "conflict",
      });
      expect(await (await bucket.get(key))?.text()).toBe(corrupted);
    }
  });
});
test("R2 primitive: competing full-anchor replacements have exactly one winner", async () => {
  await withBucket(async (bucket) => {
    const before = await bucket.put("control/anchor", '{"oseq":"41","fence":"7"}', {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (!before) throw new Error("Initial conditional creation failed");
    expect(
      await bucket.put("control/anchor", "overwrite", {
        onlyIf: { etagDoesNotMatch: "*" },
      }),
    ).toBeNull();
    const candidates = [
      '{"oseq":"42","fence":"7","candidate":"a"}',
      '{"oseq":"42","fence":"7","candidate":"b"}',
    ];
    const results = await Promise.all(
      candidates.map((body) =>
        bucket.put("control/anchor", body, {
          onlyIf: { etagMatches: before.etag },
        }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const winner = results.findIndex((r) => r !== null);
    expect(await (await bucket.get("control/anchor"))?.text()).toBe(candidates[winner]);
  });
});

test("R2 primitive: a confirmed fence blocks a publisher using the previous revision", async () => {
  await withBucket(async (bucket) => {
    const original = await bucket.put("control/anchor", '{"oseq":"41","fence":"7"}');
    if (!original) throw new Error("Missing anchor");
    const latePublish = () =>
      bucket.put("control/anchor", '{"oseq":"42","fence":"7"}', {
        onlyIf: { etagMatches: original.etag },
      });
    const fencedBody = '{"oseq":"41","fence":"8"}';
    const fenced = await bucket.put("control/anchor", fencedBody, {
      onlyIf: { etagMatches: original.etag },
    });
    expect(fenced).not.toBeNull();
    expect(await latePublish()).toBeNull();
    expect(await (await bucket.get("control/anchor"))?.text()).toBe(fencedBody);
  });
});

test("R2 primitive: when publication wins, an attempted old-head fence cannot authorize abandonment", async () => {
  await withBucket(async (bucket) => {
    const original = await bucket.put("control/anchor", '{"oseq":"41","fence":"7"}');
    if (!original) throw new Error("Missing anchor");
    const selected = '{"oseq":"42","fence":"7","candidate":"rejected-42"}';
    // Deliberately discard the successful return value; this is not a network fault injection.
    await bucket.put("control/anchor", selected, { onlyIf: { etagMatches: original.etag } });
    expect(
      await bucket.put("control/anchor", '{"oseq":"41","fence":"8"}', {
        onlyIf: { etagMatches: original.etag },
      }),
    ).toBeNull();
    expect(await (await bucket.get("control/anchor"))?.text()).toBe(selected);
  });
});

test("R2 primitive: immutable payload presence does not itself change the canonical anchor", async () => {
  await withBucket(async (bucket) => {
    const priorHead = '{"oseq":"41","fence":"7"}';
    await bucket.put("control/anchor", priorHead);
    const payload = "exact synthetic candidate bytes";
    const created = await bucket.put("payload/orphan", payload, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    expect(created).not.toBeNull();
    expect(
      await bucket.put("payload/orphan", "different candidate", {
        onlyIf: { etagDoesNotMatch: "*" },
      }),
    ).toBeNull();
    expect(await (await bucket.get("payload/orphan"))?.text()).toBe(payload);
    expect(await (await bucket.get("control/anchor"))?.text()).toBe(priorHead);
  });
});
