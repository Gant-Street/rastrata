import { expect, test } from "bun:test";
import { AssertionError } from "node:assert";
import { createHash } from "node:crypto";
import { withBucket } from "./r2-fixtures.ts";

test("R2 HTTP fixture preserves binary bodies, Unicode keys, conditional writes and checksums", async () => {
  await withBucket(async (bucket) => {
    const key = "λ/账簿 ?#";
    const value = new Uint8Array([0, 255, 128, 10]);
    expect(await bucket.get(key)).toBeNull();
    const written = await bucket.put(key, value, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: createHash("sha256").update(value).digest("hex"),
    });
    expect(written).toMatchObject({ key, size: 4 });
    const read = await bucket.get(key);
    expect(read?.etag).toBe(written?.etag);
    expect(new Uint8Array(await new Response(read?.body).arrayBuffer())).toEqual(value);
    expect(await bucket.put(key, "overwrite", { onlyIf: { etagDoesNotMatch: "*" } })).toBeNull();
    expect(await bucket.put(key, "overwrite", { onlyIf: { etagMatches: "wrong" } })).toBeNull();
    if (written === null) throw new Error("Missing R2 write");
    expect(await bucket.put(key, "next", { onlyIf: { etagMatches: written.etag } })).not.toBeNull();
    expect(await (await bucket.get(key))?.text()).toBe("next");
    await expect(
      bucket.put("bad-checksum", value, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: "0".repeat(64),
      }),
    ).rejects.toThrow();
    expect(await bucket.get("bad-checksum")).toBeNull();
    await bucket.delete(key);
    expect(await bucket.get(key)).toBeNull();
    expect(await bucket.put("empty", new Uint8Array())).toMatchObject({ size: 0 });
    expect(await (await bucket.get("empty"))?.text()).toBe("");
  });
});

test("R2 fixture propagates the original assertion without retrying the callback", async () => {
  let calls = 0;
  const failure = new AssertionError({ message: "deliberate fixture failure" });
  await expect(
    withBucket(async () => {
      calls++;
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(calls).toBe(1);
});
