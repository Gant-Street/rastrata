import { afterAll, beforeAll, expect, test } from "bun:test";
import { ObjectStoreError, ObjectStoreUncertain } from "../src/objectstore.ts";
import { S3ObjectStore } from "../src/s3.ts";
import { FAKE_ACCESS, FAKE_SECRET, FakeS3 } from "./support/fake-s3.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

let fake: FakeS3;
beforeAll(() => {
  fake = new FakeS3();
});
afterAll(() => fake.stop());

const store = (options: Partial<ConstructorParameters<typeof S3ObjectStore>[0]> = {}) =>
  new S3ObjectStore({
    endpoint: fake.endpoint,
    bucket: fake.bucket,
    region: "auto",
    accessKeyId: FAKE_ACCESS,
    secretAccessKey: FAKE_SECRET,
    timeoutMs: 400,
    ...options,
  });

test("a create-only write creates once, then reports that the key exists", async () => {
  const s3 = store();
  const first = await s3.putIfAbsent("runs/t/log/000000000001", bytes("one"), {
    metadata: { Hash: "abc", Prev: "000" },
  });
  expect(first.created).toBe(true);
  expect((await s3.putIfAbsent("runs/t/log/000000000001", bytes("two"))).created).toBe(false);
  const got = (await s3.get("runs/t/log/000000000001"))!;
  expect(text(got.body)).toBe("one");
  expect(got.metadata).toEqual({ hash: "abc", prev: "000" });
  const sent = fake.requests.filter((request) => request.method === "PUT");
  expect(sent.every((request) => request.headers["if-none-match"] === "*")).toBe(true);
});

test("head, missing keys and delete", async () => {
  const s3 = store();
  await s3.putIfAbsent("h/a b+c/é", bytes("data"));
  const head = (await s3.head("h/a b+c/é"))!;
  expect(head.size).toBe(4);
  expect(head.key).toBe("h/a b+c/é");
  expect(await s3.head("h/missing")).toBeNull();
  expect(await s3.get("h/missing")).toBeNull();
  await s3.delete("h/a b+c/é");
  await s3.delete("h/a b+c/é");
  expect(await s3.get("h/a b+c/é")).toBeNull();
});

test("listing pages by start-after, decodes escaped keys and says when more follow", async () => {
  const s3 = store();
  const keys = ["l/a&b", "l/a<b>", "l/c", "l/d", "l/e", "m/x"];
  for (const key of keys) await s3.putIfAbsent(key, bytes(key));
  const first = await s3.list("l/", undefined, 2);
  expect(first.objects.map((item) => item.key)).toEqual(["l/a&b", "l/a<b>"]);
  expect(first.truncated).toBe(true);
  const second = await s3.list("l/", "l/a<b>", 2);
  expect(second.objects.map((item) => item.key)).toEqual(["l/c", "l/d"]);
  expect(second.truncated).toBe(true);
  const last = await s3.list("l/", "l/d", 2);
  expect(last.objects.map((item) => item.key)).toEqual(["l/e"]);
  expect(last.truncated).toBe(false);
  expect(last.objects[0]!.size).toBe(3);
});

test("a failure that leaves a write's fate unknown is 'uncertain'; a refusal is not", async () => {
  const s3 = store();
  fake.script.push(503);
  await expect(s3.putIfAbsent("u/1", bytes("x"))).rejects.toBeInstanceOf(ObjectStoreUncertain);
  fake.script.push(409);
  await expect(s3.putIfAbsent("u/2", bytes("x"))).rejects.toBeInstanceOf(ObjectStoreUncertain);
  fake.script.push("stall");
  await expect(s3.putIfAbsent("u/3", bytes("x"))).rejects.toBeInstanceOf(ObjectStoreUncertain);
  fake.script.push(403);
  const refused = await s3.putIfAbsent("u/4", bytes("x")).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ObjectStoreError);
  expect(refused).not.toBeInstanceOf(ObjectStoreUncertain);
  expect((refused as ObjectStoreError).status).toBe(403);
  // A read that gets a 5xx is also reported, for the caller to ask again.
  fake.script.push(500);
  await expect(s3.get("u/1")).rejects.toBeInstanceOf(ObjectStoreUncertain);
});

test("a wrong secret is refused by the service", async () => {
  const s3 = store({ secretAccessKey: "wrong" });
  const error = await s3.get("any").catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(ObjectStoreError);
  expect((error as ObjectStoreError).status).toBe(403);
});

test("a body is signed by its hash and arrives intact", async () => {
  const s3 = store();
  const big = new Uint8Array(300_000).map((_, index) => index % 251);
  expect((await s3.putIfAbsent("b/big", big)).created).toBe(true);
  const back = (await s3.get("b/big"))!;
  expect(back.size).toBe(300_000);
  expect(back.body.every((value, index) => value === index % 251)).toBe(true);
});

test("without keep-alive every request asks the server to close the connection", async () => {
  const s3 = store({ keepAlive: false });
  await s3.putIfAbsent("k/1", bytes("x"));
  const last = fake.requests[fake.requests.length - 1]!;
  expect(last.headers.connection).toBe("close");
});
