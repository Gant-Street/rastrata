import { afterEach, beforeEach, expect, test } from "bun:test";
import { API_VERSION, type BookSettings } from "@rastrata/application/client-contracts";
import { showsAccountNumbers } from "@rastrata/ui/entries/display";
import { dateFormat, formatDate, setDateFormat } from "@rastrata/ui/format";
import {
  BrowserApplicationClient,
  READ_AGAIN_MS,
  readAgain,
  type ApplicationFetch,
} from "../../src/application-client";
import { reset as resetHeld } from "../../src/held";
import {
  acceptMode,
  bookSettings,
  bookSettingsNow,
  bookSettingsReady,
  bookSettingsUnreadable,
  businessName,
  DEFAULT_BOOK_SETTINGS,
  readBookSettings,
  rememberBookUpdate,
  resetBookSettings,
  showAccountNumbers,
} from "../../src/book-settings";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

const context = (settings: unknown, name = "Willow Lane Studio") => ({
  enabled: true,
  bookId: "local-book",
  setup: { name },
  mode: "local-development",
  permissions: ["read"],
  head: null,
  ...(settings === undefined ? {} : { settings }),
});

function clientAnswering(answer: () => Response | Promise<Response>) {
  let asked = 0;
  const fetcher = (async () => {
    asked += 1;
    return answer();
  }) as ApplicationFetch;
  return { client: new BrowserApplicationClient(storage(), fetcher), asked: () => asked };
}

const ok = (data: unknown) =>
  Response.json({ version: API_VERSION, bookId: "local-book", ok: true, data });

beforeEach(() => {
  resetBookSettings();
  // What the page holds of the service (held.ts) is from the test before.
  resetHeld();
  // A read that fails is not asked again first here (tests/unit/application-client.test.ts has that).
  readAgain.waits = [];
});
// The date format is the whole app's, so a test that changes it puts it back.
afterEach(() => {
  setDateFormat("medium");
  readAgain.waits = READ_AGAIN_MS;
});

test("the defaults apply until the book has been read, and then its own settings do", async () => {
  const saved: BookSettings = {
    dateFormat: "numeric",
    showAccountNumbers: true,
    acceptMode: "draft",
  };
  const { client } = clientAnswering(() => ok(context(saved)));
  expect(readBookSettings.length).toBeLessThanOrEqual(1);
  const read = await readBookSettings({ client });
  expect(read).toEqual({ name: "Willow Lane Studio", settings: saved });
  expect(bookSettings()).toEqual(saved);
  expect(businessName()).toBe("Willow Lane Studio");
  expect(acceptMode()).toBe("draft");
  expect(showAccountNumbers()).toBe(true);
  // The shared components read the same preference, so a list follows it at once.
  expect(showsAccountNumbers()).toBe(true);
});

test("a book that reports no settings (an older service) reads as the defaults", async () => {
  const { client } = clientAnswering(() => ok(context(undefined)));
  await readBookSettings({ client });
  expect(bookSettings()).toEqual(DEFAULT_BOOK_SETTINGS);
  expect(acceptMode()).toBe("post");
});

test("it reads once, however many screens ask, and again only when told the book changed", async () => {
  const { client, asked } = clientAnswering(() => ok(context(DEFAULT_BOOK_SETTINGS)));
  await Promise.all([readBookSettings({ client }), readBookSettings({ client })]);
  await bookSettingsReady();
  expect(asked()).toBe(1);
  await readBookSettings({ client, again: true });
  expect(asked()).toBe(2);
});

test("a read that fails says so, leaves the defaults, and is tried again by the next ask", async () => {
  let fail = true;
  const { client, asked } = clientAnswering(() => {
    if (fail) throw new Error("service down");
    return ok(context({ ...DEFAULT_BOOK_SETTINGS, acceptMode: "draft" }));
  });
  expect(await readBookSettings({ client })).toBeUndefined();
  expect(bookSettingsUnreadable()).toBe(true);
  expect(acceptMode()).toBe("post");
  fail = false;
  expect(await readBookSettings({ client })).toBeDefined();
  expect(asked()).toBe(2);
  expect(bookSettingsUnreadable()).toBe(false);
  expect(acceptMode()).toBe("draft");
});

test("the reply to book.update is taken as the truth without another read", () => {
  rememberBookUpdate({
    name: "Renamed Co",
    settings: { dateFormat: "iso", showAccountNumbers: true, acceptMode: "draft" },
    changed: ["name"],
    previousName: "Willow Lane Studio",
  });
  expect(businessName()).toBe("Renamed Co");
  expect(bookSettings().dateFormat).toBe("iso");
  expect(showsAccountNumbers()).toBe(true);
});

test("the date format the owner chose is the one every date is written in, from the first read and after a save", async () => {
  const { client } = clientAnswering(() =>
    ok(context({ ...DEFAULT_BOOK_SETTINGS, dateFormat: "numeric" })),
  );
  expect(dateFormat()).toBe("medium");
  await readBookSettings({ client });
  expect(dateFormat()).toBe("numeric");
  expect(formatDate("2026-03-20")).toBe(formatDate("2026-03-20", { format: "numeric" }));
  rememberBookUpdate({
    name: "Willow Lane Studio",
    settings: { ...DEFAULT_BOOK_SETTINGS, dateFormat: "iso" },
    changed: ["dateFormat"],
    previousName: "Willow Lane Studio",
  });
  expect(dateFormat()).toBe("iso");
  expect(formatDate("2026-03-20")).toBe("2026-03-20");
  resetBookSettings();
  expect(dateFormat()).toBe("medium");
});

test("the settings now are asked of the service and not given from what the page holds, and where it cannot be asked what the page holds is what there is", async () => {
  let mode: "post" | "draft" = "post";
  let reachable = true;
  const { client, asked } = clientAnswering(() => {
    if (!reachable) throw new Error("offline");
    return ok(context({ ...DEFAULT_BOOK_SETTINGS, acceptMode: mode }));
  });
  await readBookSettings({ client });
  expect(acceptMode()).toBe("post");
  // The owner chose differently from another device a moment ago, inside the time what the page holds counts as a read.
  mode = "draft";
  expect((await bookSettingsNow())?.settings.acceptMode).toBe("draft");
  expect(acceptMode()).toBe("draft");
  expect(asked()).toBe(2);
  // The service cannot be asked: the action's own request fails as well, and what the page holds is what there is.
  reachable = false;
  mode = "post";
  expect((await bookSettingsNow())?.settings.acceptMode).toBe("draft");
  expect(acceptMode()).toBe("draft");
});
