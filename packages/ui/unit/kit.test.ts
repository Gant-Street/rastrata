import { afterEach, describe, expect, test } from "bun:test";
import { writeToClipboard } from "../src/kit/copy";
import { defaultMessages } from "../src/messages";
import { machineType, planToast, toastDuration, TOASTS_VISIBLE } from "../src/kit/toast-options";
import { TONES, toneOf, type Tone } from "../src/kit/tones";

describe("the four tones", () => {
  test("there are exactly four, each with one colour and one meaning", () => {
    expect(TONES.map((note) => note.tone)).toEqual(["calm", "info", "attention", "problem"]);
    expect(TONES.map((note) => note.colour)).toEqual(["grey", "blue", "orange", "red"]);
    expect(new Set(TONES.map((note) => note.means)).size).toBe(4);
    for (const note of TONES) {
      expect(note.means.length).toBeGreaterThan(10);
      expect(note.use.length).toBeGreaterThan(10);
      expect(note.never.length).toBeGreaterThan(10);
    }
  });

  test("orange is rationed: attention is for a decision or a change in the figures, never a fact", () => {
    const attention = TONES.find((note) => note.tone === "attention");
    expect(attention?.means).toContain("decide");
    expect(attention?.never).toContain("fact");
    expect(attention?.never).toContain("new book");
  });

  test("the tones say what to do: nothing, know, decide, fix", () => {
    const byTone = Object.fromEntries(TONES.map((note) => [note.tone, note.means])) as Record<
      Tone,
      string
    >;
    expect(byTone.calm).toContain("Nothing to do");
    expect(byTone.info).toContain("no decision");
    expect(byTone.attention).toContain("decide");
    expect(byTone.problem).toContain("failed");
  });
});

describe("toneOf", () => {
  test("a tone is itself", () => {
    for (const tone of ["calm", "info", "attention", "problem"] as const)
      expect(toneOf(tone, "calm")).toBe(tone);
  });

  test("the names used before the kit mean what they always meant", () => {
    expect(toneOf("neutral", "info")).toBe("calm");
    expect(toneOf("review", "info")).toBe("attention");
    expect(toneOf("error", "info")).toBe("problem");
  });

  test("no tone is the fallback the component chose", () => {
    expect(toneOf(undefined, "info")).toBe("info");
    expect(toneOf(undefined, "calm")).toBe("calm");
  });
});

describe("how long a toast stays", () => {
  test("a plain toast stays five seconds, a note a little longer, a decision longer still", () => {
    expect(toastDuration("calm", false)).toBe(5_000);
    expect(toastDuration("info", false)).toBe(6_000);
    expect(toastDuration("attention", false)).toBe(8_000);
  });

  test("a toast with an action stays at least ten seconds, so the action can be reached", () => {
    expect(toastDuration("calm", true)).toBe(10_000);
    expect(toastDuration("info", true)).toBe(10_000);
    expect(toastDuration("attention", true)).toBe(10_000);
  });

  test("a problem stays until it is dismissed, with or without an action", () => {
    expect(toastDuration("problem", false)).toBe(Number.POSITIVE_INFINITY);
    expect(toastDuration("problem", true)).toBe(Number.POSITIVE_INFINITY);
  });

  test("a caller's own time wins, and zero or infinity means until dismissed", () => {
    expect(toastDuration("calm", true, 2_000)).toBe(2_000);
    expect(toastDuration("problem", false, 3_000)).toBe(3_000);
    expect(toastDuration("calm", false, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(toastDuration("calm", false, Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(toastDuration("calm", false, -1)).toBe(Number.POSITIVE_INFINITY);
  });

  test("the toast machine ranks the queue by its own type: a problem first, then what needs a decision", () => {
    expect(machineType("problem")).toBe("error");
    expect(machineType("attention")).toBe("warning");
    expect(machineType("info")).toBe("info");
    expect(machineType("calm")).toBe("info");
  });

  test("a toast's options decide everything in one place", () => {
    expect(planToast({ message: "Posted 6 transactions." })).toEqual({
      tone: "calm",
      duration: 5_000,
      type: "info",
    });
    expect(
      planToast({
        message: "Posted 6 transactions.",
        action: { label: "Undo", onSelect: () => undefined },
      }),
    ).toEqual({ tone: "calm", duration: 10_000, type: "info" });
    expect(planToast({ message: "Could not post.", tone: "error" })).toEqual({
      tone: "problem",
      duration: Number.POSITIVE_INFINITY,
      type: "error",
    });
  });

  test("three toasts show at once and the rest wait", () => {
    expect(TOASTS_VISIBLE).toBe(3);
  });
});

describe("the words the kit owns", () => {
  test("every copy button says what it copies, and a refusal is said in words", () => {
    const m = defaultMessages.kit.details;
    expect(m.copy).toBe("Copy");
    expect(m.copyOf("fingerprint")).toBe("Copy fingerprint");
    expect(m.copiedOf("fingerprint")).toBe("Copied fingerprint");
    expect(m.copyFailed).toContain("Could not copy");
  });

  test("a calm marker is a fact and says nothing to a screen reader; the others say their tone", () => {
    expect(defaultMessages.kit.tone).toEqual({
      calm: "",
      info: "Good to know",
      attention: "Needs attention",
      problem: "Problem",
    });
  });
});

describe("writeToClipboard", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const setNavigator = (value: unknown) =>
    Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (originalElement) Object.defineProperty(globalThis, "HTMLElement", originalElement);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
  });

  test("it waits for the write and reports that it worked", async () => {
    const written: string[] = [];
    setNavigator({
      clipboard: {
        writeText: async (text: string) => {
          await Promise.resolve();
          written.push(text);
        },
      },
    });
    expect(await writeToClipboard("61e985c0")).toBe("copied");
    expect(written).toEqual(["61e985c0"]);
  });

  test("when the clipboard refuses and nothing else can copy, it says it failed", async () => {
    setNavigator({
      clipboard: {
        writeText: () => Promise.reject(new Error("NotAllowedError")),
      },
    });
    // There is no document here, so the older selection-and-copy way has nowhere to work.
    Reflect.deleteProperty(globalThis, "document");
    expect(await writeToClipboard("61e985c0")).toBe("failed");
  });

  test("when there is no clipboard and nothing else can copy, it says it failed", async () => {
    setNavigator({});
    Reflect.deleteProperty(globalThis, "document");
    expect(await writeToClipboard("61e985c0")).toBe("failed");
  });

  test("when the clipboard refuses, the older way is tried, and focus goes back where it was", async () => {
    setNavigator({ clipboard: { writeText: () => Promise.reject(new Error("denied")) } });
    class FakeElement {
      style: Record<string, string> = {};
      value = "";
      tabIndex = 0;
      focused = 0;
      removed = false;
      setAttribute() {}
      focus() {
        this.focused += 1;
      }
      select() {}
      remove() {
        this.removed = true;
      }
    }
    Object.defineProperty(globalThis, "HTMLElement", {
      value: FakeElement,
      configurable: true,
      writable: true,
    });
    const before = new FakeElement();
    const field = new FakeElement();
    const copies: string[] = [];
    Object.defineProperty(globalThis, "document", {
      value: {
        activeElement: before,
        body: { append: () => undefined },
        createElement: () => field,
        execCommand: (command: string) => {
          copies.push(`${command}:${field.value}`);
          return true;
        },
      },
      configurable: true,
      writable: true,
    });
    expect(await writeToClipboard("source-87f3d1")).toBe("copied");
    expect(copies).toEqual(["copy:source-87f3d1"]);
    expect(field.removed).toBe(true);
    expect(before.focused).toBe(1);
  });

  test("when the older way says no too, it failed", async () => {
    setNavigator({});
    class FakeElement {
      style: Record<string, string> = {};
      value = "";
      tabIndex = 0;
      setAttribute() {}
      focus() {}
      select() {}
      remove() {}
    }
    Object.defineProperty(globalThis, "HTMLElement", {
      value: FakeElement,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: {
        activeElement: null,
        body: { append: () => undefined },
        createElement: () => new FakeElement(),
        execCommand: () => false,
      },
      configurable: true,
      writable: true,
    });
    expect(await writeToClipboard("x")).toBe("failed");
  });
});
