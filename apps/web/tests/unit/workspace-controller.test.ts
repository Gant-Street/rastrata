// What Settings, Workspace does to take the books away (src/workspace-controller.ts), against stand-ins for the service and for saving.
import { expect, test } from "bun:test";
import type { BackupJob } from "@rastrata/application/client-contracts";
import { ApplicationRequestError } from "../../src/application-client";
import {
  DeleteController,
  type DeleteState,
  EXPORT_WORKFLOW,
  ExportController,
  type ExportState,
  exportProblem,
  sameName,
} from "../../src/workspace-controller";

const ID = "20261015T052707Z-00000004-b5e16361";
const done = (extra: Partial<BackupJob> = {}): BackupJob =>
  ({
    state: "done",
    kind: "export",
    startedAt: "2026-10-15T05:27:07Z",
    stage: "Done",
    done: 1,
    total: 1,
    elapsedMs: 10,
    remainingMs: 0,
    export: { id: ID },
    ...extra,
  }) as BackupJob;

function setUp(
  options: {
    job?: () => Promise<BackupJob>;
    progress?: Partial<BackupJob>[];
    fetched?: () => Promise<Response>;
  } = {},
) {
  const asked: string[] = [];
  const saved: { name: string; size: number }[] = [];
  const workflows: string[] = [];
  const controller = new ExportController({
    pollMs: 1,
    client: {
      writeJob: (async (
        name: string,
        _input: unknown,
        workflow: string,
        jobOptions: { onProgress?: (job: BackupJob) => void } = {},
      ) => {
        asked.push(name);
        workflows.push(workflow);
        for (const step of options.progress ?? []) jobOptions.onProgress?.(done(step));
        return (options.job ?? (async () => done()))();
      }) as never,
    },
    fetcher: async (path) => {
      asked.push(path);
      return (options.fetched ?? (async () => new Response(new Uint8Array(1234))))();
    },
    save: (file, name) => void saved.push({ name, size: file.size }),
  });
  const states: ExportState[] = [];
  controller.subscribe((state) => states.push(state));
  return { controller, asked, saved, workflows, states };
}

test("the export is made, fetched and saved, with what the service says on the way", async () => {
  const f = setUp({
    progress: [
      { stage: "Reading the book", done: null, total: null },
      { stage: "Writing the journal", done: 50, total: 200 },
    ],
  });
  expect(f.controller.state.step).toBe("idle");
  await f.controller.run();
  expect(f.states).toEqual([
    { step: "making", stage: null, percent: null },
    { step: "making", stage: "Reading the book", percent: null },
    { step: "making", stage: "Writing the journal", percent: 25 },
    { step: "fetching" },
    { step: "done", name: `${ID}.zip`, bytes: 1234 },
  ]);
  expect(f.asked).toEqual(["export.create", `/v1/exports/${ID}`]);
  expect(f.workflows).toEqual([EXPORT_WORKFLOW]);
  expect(f.saved).toEqual([{ name: `${ID}.zip`, size: 1234 }]);
});

test("a second click while the first is under way is the first: one job, one file", async () => {
  let release: (job: BackupJob) => void = () => {};
  let job: Promise<BackupJob> = new Promise((resolve) => {
    release = resolve;
  });
  const f = setUp({ job: () => job });
  const first = f.controller.run();
  const second = f.controller.run();
  await second;
  expect(f.asked).toEqual(["export.create"]);
  release(done());
  await first;
  expect(f.saved).toHaveLength(1);
  // And once it has ended, a new one can be made.
  job = Promise.resolve(done());
  await f.controller.run();
  expect(f.saved).toHaveLength(2);
});

test("what goes wrong is said in a person's words: not allowed, busy, the job failed, no export in the answer, the fetch refused or lost, a broken download", async () => {
  const failed = async (f: ReturnType<typeof setUp>): Promise<string> => {
    await f.controller.run();
    const state = f.controller.state;
    if (state.step !== "failed") throw new Error(`not failed: ${state.step}`);
    return state.message;
  };
  const error = (code: string, message = "x") =>
    setUp({ job: async () => Promise.reject(new ApplicationRequestError(message, code)) });
  expect(await failed(error("permission_denied"))).toBe(
    "Only an owner or an administrator can export the books.",
  );
  expect(await failed(error("server_busy"))).toBe("The service is busy. Try again in a moment.");
  expect(await failed(error("rate_limited"))).toBe("The service is busy. Try again in a moment.");
  expect(await failed(error("backup_unavailable"))).toBe(
    "This service cannot make an export of the books.",
  );
  expect(await failed(error("export_failed", "The ledger has a gap in its history."))).toBe(
    "The ledger has a gap in its history.",
  );
  expect(await failed(setUp({ job: async () => Promise.reject(new TypeError("offline")) }))).toBe(
    "The export could not be made. Try again in a moment.",
  );
  expect(
    await failed(
      setUp({
        job: async () =>
          done({ state: "failed", error: { code: "export_failed", message: "Out of space." } }),
      }),
    ),
  ).toBe("Out of space.");
  expect(await failed(setUp({ job: async () => done({ export: undefined as never }) }))).toBe(
    "The export could not be made. Try again in a moment.",
  );
  for (const [status, message] of [
    [403, "Only an owner or an administrator can export the books."],
    [404, "The export is no longer there. Make it again."],
    [500, "The export could not be fetched. Try again."],
  ] as const)
    expect(await failed(setUp({ fetched: async () => new Response("no", { status }) }))).toBe(
      message,
    );
  expect(
    await failed(setUp({ fetched: async () => Promise.reject(new TypeError("offline")) })),
  ).toBe("The export could not be fetched. Try again.");
  const broken = new Response(
    new ReadableStream({
      start: (controller) => controller.error(new Error("reset")),
    }),
  );
  expect(await failed(setUp({ fetched: async () => broken }))).toBe(
    "The download broke off. Try again.",
  );
  // Nothing was saved by any of them.
  const f = setUp({ fetched: async () => new Response("no", { status: 500 }) });
  await f.controller.run();
  expect(f.saved).toEqual([]);
  expect(exportProblem(undefined)).toBe("The export could not be made. Try again in a moment.");
});

// ---- deleting the workspace

test("what is typed is the name as it is shown: one space between words, whatever was typed, and nothing else", () => {
  expect(sameName("Acme Books", "Acme Books")).toBe(true);
  expect(sameName("  Acme    Books ", "Acme Books")).toBe(true);
  for (const wrong of ["", "acme books", "Acme", "Acme Books!", "Acme Books Ltd"])
    expect(sameName(wrong, "Acme Books"), JSON.stringify(wrong)).toBe(false);
});

function deleting(answer: () => Promise<unknown> = async () => ({ ok: true, value: {} })) {
  const asked: string[] = [];
  const forgot: number[] = [];
  const went: string[] = [];
  const controller = new DeleteController({
    account: {
      deleteWorkspace: async (id: string, confirm: string) => {
        asked.push(`${id}|${confirm}`);
        return (await answer()) as never;
      },
    },
    workspace: { id: "wsp_acme", name: "Acme Books" },
    forget: () => void forgot.push(1),
    go: (path) => void went.push(path),
    leaveFor: "/start?choose=1",
  });
  const states: DeleteState[] = [];
  controller.subscribe((state) => states.push(state));
  return { controller, asked, forgot, went, states };
}

test("the name is typed, the control plane deletes, the page forgets the workspace and leaves for the list of workspaces", async () => {
  const f = deleting();
  await f.controller.run("  Acme   Books ");
  expect(f.asked).toEqual(["wsp_acme|  Acme   Books "]);
  expect(f.states.map((s) => s.step)).toEqual(["deleting", "done"]);
  expect(f.forgot).toEqual([1]);
  expect(f.went).toEqual(["/start?choose=1"]);
});

test("nothing is sent until what was typed is the name, and a refusal is shown in the control plane's words and leaves the workspace open", async () => {
  const f = deleting();
  await f.controller.run("Acme");
  expect(f.asked).toEqual([]);
  expect(f.controller.state).toEqual({
    step: "failed",
    message: "Type the name of the workspace to delete it.",
  });
  const refused = deleting(async () => ({
    ok: false,
    status: 403,
    code: "forbidden",
    message: "Only an owner can delete a workspace.",
    retryAfter: null,
  }));
  await refused.controller.run("Acme Books");
  expect(refused.controller.state).toEqual({
    step: "failed",
    message: "Only an owner can delete a workspace.",
  });
  expect(refused.forgot).toEqual([]);
  expect(refused.went).toEqual([]);
});

test("a second press while it is under way is the first", async () => {
  let release: (value: unknown) => void = () => {};
  const f = deleting(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = f.controller.run("Acme Books");
  await f.controller.run("Acme Books");
  expect(f.asked).toHaveLength(1);
  release({ ok: true, value: {} });
  await first;
  expect(f.went).toEqual(["/start?choose=1"]);
});
