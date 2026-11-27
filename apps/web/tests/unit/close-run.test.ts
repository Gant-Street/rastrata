import { expect, test } from "bun:test";
import { closeRun } from "../../src/routes/accounting/close-run";

/** A host that records what was asked, and answers as told. */
function host(options: { notReady?: readonly string[]; refused?: readonly string[] } = {}) {
  const asked: string[] = [];
  return {
    asked,
    steps: {
      ready: async (id: string) => {
        asked.push(`ready ${id}`);
        return !(options.notReady ?? []).includes(id);
      },
      close: async (id: string) => {
        asked.push(`close ${id}`);
        return !(options.refused ?? []).includes(id);
      },
    },
  };
}

const run = ["jan", "feb", "mar"];

test("every month is checked and then closed, in order, oldest first", async () => {
  const { asked, steps } = host();
  expect(await closeRun(run, steps)).toEqual({ closed: run, stoppedAt: null });
  expect(asked).toEqual([
    "ready jan",
    "close jan",
    "ready feb",
    "close feb",
    "ready mar",
    "close mar",
  ]);
});

test("a month whose checklist is not ready stops the run before it; the ones before it stayed closed", async () => {
  const { asked, steps } = host({ notReady: ["feb"] });
  expect(await closeRun(run, steps)).toEqual({ closed: ["jan"], stoppedAt: "feb" });
  // February was not closed, and March was never asked about.
  expect(asked).toEqual(["ready jan", "close jan", "ready feb"]);
});

test("a close that did not go through stops the run at that month", async () => {
  const { asked, steps } = host({ refused: ["mar"] });
  expect(await closeRun(run, steps)).toEqual({ closed: ["jan", "feb"], stoppedAt: "mar" });
  expect(asked.at(-1)).toBe("close mar");
});

test("the first month can be the one that stops it, with nothing closed", async () => {
  const { steps } = host({ refused: ["jan"] });
  expect(await closeRun(run, steps)).toEqual({ closed: [], stoppedAt: "jan" });
});
