import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLE_PERMISSIONS } from "../src/agent/member.ts";
import { ApplicationHttp } from "../src/http.ts";
import { createExportGate, createHostedExportHost } from "../src/local/hosted-exports.ts";
import { importOpenExport, LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION } from "../src/schema.ts";
import { cleanupSafetyFixtures, safetyFixture, type SafetyFixture } from "./support/safety.ts";

// A hosted pod keeps its own backups and has no safety host, but it can export: the open export a book makes, kept for an hour in a folder of the book's own and
// fetched as one zip (`GET /v1/exports/<id>`). What is checked here is the whole path: the job that makes it, the list that names it, the download and who may make it, the
// zip itself read by the system's unzip, and what matters most, that the book comes back from it: the extracted export rebuilds the identical book by replay.
afterEach(cleanupSafetyFixtures);

const unzip = Bun.which("unzip");

/** A book on a runtime with exports and no safety host, with a clock the test moves. */
async function hostedBook(options: { keepForMs?: number; keep?: number } = {}) {
  // The folders have their real times, so the clock starts at the real time and the test moves it on.
  const clock = { at: Date.now() };
  const root = mkdtempSync(join(tmpdir(), "rastrata-hosted-export-"));
  const directory = join(root, "scratch", "exports");
  const f = await safetyFixture({
    directory: root,
    open: { safety: false, exports: { directory, now: () => clock.at, ...options } },
  });
  return { f, clock, directory };
}

/** The book is set up by the fixture; this puts some entries in it. */
async function setUp(f: SafetyFixture, entries = 3): Promise<void> {
  await f.post(entries, "H");
}

/** `GET /v1/exports/<id>` as a caller with these permissions. */
async function download(
  f: SafetyFixture,
  id: string,
  role: keyof typeof ROLE_PERMISSIONS = "owner",
) {
  const http = new ApplicationHttp(f.service, {
    bookId: f.service.bookId,
    permissions: ROLE_PERMISSIONS[role],
  });
  return http.fetch(new Request(`http://127.0.0.1:4010/v1/exports/${id}`));
}

test("a runtime that cannot back up can export: the job runs, the export is listed where it is fetched from, and every backup operation still says the platform keeps them", async () => {
  const { f } = await hostedBook();
  await setUp(f);
  for (const name of ["backup.status", "backup.list", "backup.create"]) {
    const refused = await f.call(name, {}, crypto.randomUUID());
    expect(refused.status, name).toBe(501);
    expect(refused.body.error.code).toBe("backup_unavailable");
    // What a person or an agent is told is what is so here (the history is kept, and an export is the way to hold a copy), and not a developer's instruction.
    expect(refused.body.error.message, name).toContain("keeps the history of the books itself");
    expect(refused.body.error.message, name).toContain("export.create");
    expect(refused.body.error.message, name).not.toContain("bun run");
  }
  const made = (await f.finish("export.create")).export;
  expect(made.format).toBe("rastrata-export-v1");
  // Where it is is where it is fetched from, and nothing of the pod's folders.
  expect(made.location).toBe(`/v1/exports/${made.id}`);
  const listed = await f.call("export.list");
  expect(listed.status).toBe(200);
  expect(listed.body.data.exports.map((e: { id: string }) => e.id)).toEqual([made.id]);
  expect(JSON.stringify(listed.body)).not.toContain(f.directory);
});

test("the download is a zip of the whole export that the system's own unzip reads, and the book comes back from it by replay with the same head", async () => {
  const { f } = await hostedBook();
  await setUp(f, 5);
  const made = (await f.finish("export.create")).export;
  const response = await download(f, made.id);
  if (response.status !== 200)
    console.log("DOWNLOAD", response.status, await response.clone().text());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/zip");
  expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${made.id}.zip"`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!unzip) return;
  const where = join(f.directory, "downloaded");
  mkdirSync(where, { recursive: true });
  const archive = join(where, "export.zip");
  writeFileSync(archive, bytes);
  expect(Bun.spawnSync([unzip, "-tq", archive]).exitCode).toBe(0);
  expect(Bun.spawnSync([unzip, "-q", archive, "-d", where]).exitCode).toBe(0);
  // One folder, named for the export, with the files of the format.
  expect(readdirSync(where).filter((name) => name !== "export.zip")).toEqual([made.id]);
  const files = readdirSync(join(where, made.id));
  for (const name of [
    "README.md",
    "manifest.json",
    "book.json",
    "journals.jsonl",
    "commands.jsonl",
  ])
    expect(files).toContain(name);
  // The extracted export is the export on the pod's disk, file for file.
  const onDisk = join(f.directory, "scratch", "exports", made.id);
  for (const name of readdirSync(onDisk))
    expect(readFileSync(join(where, made.id, name)).equals(readFileSync(join(onDisk, name)))).toBe(
      true,
    );
  // And it is a whole book: replayed into a new file it ends at the chain hash the live book has.
  const live = await f.service.readAggregate();
  const rebuilt = join(where, "rebuilt", "book.sqlite");
  const result = await importOpenExport({ directory: join(where, made.id), to: rebuilt });
  expect(result.head).toEqual(live.head);
  const reopened = await LocalBookService.open(rebuilt, { safety: false });
  expect(reopened.setupState()?.name).toBe("Safety Co");
  expect((await reopened.readAggregate(undefined, { verify: "full" })).head).toEqual(live.head);
  reopened.close();
});

test("only a person who may configure the book can fetch an export: owners and administrators, not accountants or members", async () => {
  const { f } = await hostedBook();
  await setUp(f);
  const made = (await f.finish("export.create")).export;
  expect((await download(f, made.id, "owner")).status).toBe(200);
  expect((await download(f, made.id, "admin")).status).toBe(200);
  for (const role of ["accountant", "member"] as const) {
    const refused = await download(f, made.id, role);
    expect(refused.status, role).toBe(403);
    expect((await refused.json()).error.code).toBe("permission_denied");
  }
  // Making one asks the same of the caller.
  for (const role of ["accountant", "member"] as const) {
    const http = new ApplicationHttp(f.service, {
      bookId: f.service.bookId,
      permissions: ROLE_PERMISSIONS[role],
    });
    const refused = await http.fetch(
      new Request("http://127.0.0.1:4010/v1/export.create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          operationId: crypto.randomUUID(),
          input: {},
        }),
      }),
    );
    expect(refused.status, role).toBe(403);
  }
});

test("an export that is not there, an identifier that is not one, a query and a method that is not GET are each refused, and nothing outside the export folder can be named", async () => {
  const { f } = await hostedBook();
  await setUp(f);
  const made = (await f.finish("export.create")).export;
  const http = new ApplicationHttp(f.service, {
    bookId: f.service.bookId,
    permissions: ROLE_PERMISSIONS.owner,
  });
  const ask = async (path: string, method = "GET") =>
    http.fetch(new Request(`http://127.0.0.1:4010${path}`, { method }));
  expect((await ask("/v1/exports/20260101T000000Z-00000001-aaaaaaaa")).status).toBe(404);
  expect((await ask(`/v1/exports/${made.id}?x=1`)).status).toBe(404);
  expect((await ask(`/v1/exports/${made.id}`, "POST")).status).toBe(405);
  for (const path of [
    "/v1/exports/..",
    "/v1/exports/../book.sqlite",
    "/v1/exports/%2e%2e%2fbook.sqlite",
    "/v1/exports/.partial-x",
    "/v1/exports/",
    "/v1/exports",
    `/v1/exports/${made.id}/manifest.json`,
  ]) {
    const answered = await ask(path);
    expect([404, 405], path).toContain(answered.status);
  }
  // An export folder that is not a valid export (no manifest of its own hash) is not offered either.
  const impostor = join(f.directory, "scratch", "exports", "20260101T000000Z-00000002-bbbbbbbb");
  mkdirSync(impostor, { recursive: true });
  writeFileSync(join(impostor, "manifest.json"), "{}");
  expect((await ask("/v1/exports/20260101T000000Z-00000002-bbbbbbbb")).status).toBe(404);
});

test("an export is kept for an hour and then removed, only the newest few are kept, and one a crash left half made is cleared", async () => {
  const { f, clock, directory } = await hostedBook({ keep: 2 });
  await setUp(f);
  const first = (await f.finish("export.create")).export;
  expect((await download(f, first.id)).status).toBe(200);
  // More entries make a different export (the head is in its name); keeping two, the third makes the oldest go.
  clock.at += 60_000;
  await f.post(1, "K");
  const second = (await f.finish("export.create")).export;
  clock.at += 60_000;
  await f.post(1, "L");
  const third = (await f.finish("export.create")).export;
  const kept = (await f.call("export.list")).body.data.exports.map((e: { id: string }) => e.id);
  expect(kept.sort()).toEqual([second.id, third.id].sort());
  expect(existsSync(join(directory, first.id))).toBe(false);
  expect((await download(f, first.id)).status).toBe(404);
  // A working folder an export left when it stopped is removed when it has been there past the hour.
  const abandoned = join(directory, ".partial-abc-12345678");
  mkdirSync(abandoned, { recursive: true });
  writeFileSync(join(abandoned, "journals.jsonl"), "x");
  clock.at += 3_600_000 + 1;
  // The time is the folder's own, so stand it in the past.
  const old = new Date(clock.at - 3_600_001 - 1000);
  utimesSync(abandoned, old, old);
  for (const id of [second.id, third.id]) utimesSync(join(directory, id), old, old);
  expect((await f.call("export.list")).body.data.exports).toEqual([]);
  expect(existsSync(abandoned)).toBe(false);
  expect((await download(f, third.id)).status).toBe(404);
});

test("exports take turns: with one place in line a second export waits until the first has ended, however it ends, in the order they asked", async () => {
  const root = mkdtempSync(join(tmpdir(), "rastrata-gate-"));
  const gate = createExportGate(1);
  const a = createHostedExportHost({ directory: join(root, "a"), gate, minGapMs: 0 });
  const b = createHostedExportHost({ directory: join(root, "b"), gate, minGapMs: 0 });
  const c = createHostedExportHost({ directory: join(root, "c"), gate, minGapMs: 0 });
  const order: string[] = [];
  const first = await a.beginExport("20260101T000000Z-00000001-aaaaaaaa");
  const second = b.beginExport("20260101T000000Z-00000001-bbbbbbbb").then((sink) => {
    order.push("b");
    return sink;
  });
  const third = c.beginExport("20260101T000000Z-00000001-cccccccc").then((sink) => {
    order.push("c");
    return sink;
  });
  await new Promise((done) => setTimeout(done, 30));
  expect(order).toEqual([]);
  // The first has an end that is an abort (a failed export gives its place back as well as a finished one).
  await first.abort();
  const sinkB = await second;
  expect(order).toEqual(["b"]);
  await new Promise((done) => setTimeout(done, 30));
  expect(order).toEqual(["b"]);
  const file = await sinkB.file("README.md");
  await file.write("x");
  await file.close();
  await sinkB.finish();
  const sinkC = await third;
  expect(order).toEqual(["b", "c"]);
  await sinkC.abort();
  // A place given back twice is given back once.
  const again = await a.beginExport("20260101T000000Z-00000002-aaaaaaaa");
  await again.abort();
  await again.abort();
  const x = await b.beginExport("20260101T000000Z-00000002-bbbbbbbb");
  let waited = true;
  const y = c.beginExport("20260101T000000Z-00000002-cccccccc").then(() => {
    waited = false;
  });
  await new Promise((done) => setTimeout(done, 30));
  expect(waited).toBe(true);
  await x.abort();
  await y;
  rmSync(root, { recursive: true, force: true });
});

test("a book is exported at most once a minute, and the refusal says what to do", async () => {
  const { f, clock } = await hostedBook();
  await setUp(f);
  const first = (await f.finish("export.create")).export;
  // A second at once is a job that failed with a reason, not an export.
  const id = crypto.randomUUID();
  const again = await f.call("export.create", {}, id);
  expect(again.status).toBe(200);
  let job = again.body.data;
  for (let attempt = 0; attempt < 100 && job.state === "running"; attempt += 1) {
    await new Promise((done) => setTimeout(done, 20));
    job = (await f.call("export.create", {}, id)).body.data;
  }
  expect(job.state).toBe("failed");
  expect(job.error.code).toBe("export_too_soon");
  expect(job.error.message).toBe(
    "An export was made a moment ago. Fetch that one, or try again in a minute.",
  );
  // The first is still there to fetch.
  expect((await download(f, first.id)).status).toBe(200);
  // After the minute another can be made.
  clock.at += 60_000;
  await f.post(1, "M");
  expect((await f.finish("export.create")).export.id).not.toBe(first.id);
});
