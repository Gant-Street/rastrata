/** The first step of the catch-all lane, with a real death: a process that kills itself with SIGKILL
 * between two steps of moving twenty transactions, and another that sends the same request again.
 * `entries-recategorize-kill.test.ts` does the same with a throw and fifty transactions; this is the
 * evidence that nothing depends on the process having been able to clean up after itself. */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { closeFixtures, type Json } from "./support/ingest-fixture.ts";
import { TO, before, expectMovedOnce, postedBook, uuid } from "./support/move-book.ts";

afterEach(() => closeFixtures());

const COUNT = 20;
const CHILD = join(import.meta.dir, "support", "move-child.ts");

/** Run the child to its end or its death. */
async function child(
  path: string,
  input: unknown,
  operationId: string,
  dieAt?: string,
): Promise<{ signal: string | number | null; exitCode: number | null; body: Json | null }> {
  const process = Bun.spawn(
    ["bun", CHILD, path, JSON.stringify(input), operationId, ...(dieAt ? [dieAt] : [])],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(process.stdout).text();
  await process.exited;
  const last = out.trim().split("\n").at(-1);
  return {
    signal: process.signalCode,
    exitCode: process.exitCode,
    body: last ? (JSON.parse(last) as Json) : null,
  };
}

const POINTS = [
  ["before", "reverse"],
  ["after", "reverse"],
  ["after", "return"],
  ["before", "categorize"],
  ["after", "categorize"],
  ["before", "post"],
  ["after", "post"],
] as const;

for (const [when, step] of POINTS) {
  const point = `${when}:${step}:9`;
  test(`twenty transactions moved by a process that is killed ${when} the ${step} step of the 9th, then sent again by another, end posted once`, async () => {
    const { f, ids } = await postedBook(COUNT);
    const start = await before(f, ids);
    const input = { itemIds: ids, accountId: TO };
    const operationId = uuid();
    // The book is in a file, and the parent lets go of it: the children are the only processes using it.
    const path = f.path;
    f.service.close();

    const died = await child(path, input, operationId, point);
    expect(died.signal, JSON.stringify(died)).toBe("SIGKILL");
    expect(died.body).toBeNull();

    const finished = await child(path, input, operationId);
    expect(finished.exitCode, JSON.stringify(finished)).toBe(0);
    expect(finished.body?.ok, JSON.stringify(finished.body)).toBe(true);

    await f.restart();
    await expectMovedOnce(f, ids, start, finished.body?.data);
    expect(
      f.service.store
        .query("SELECT COUNT(*) AS n FROM entries_moves WHERE operation_id=?")
        .get(operationId),
    ).toMatchObject({ n: COUNT });
  });
}
