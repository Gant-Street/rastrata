import { expect, test } from "bun:test";
import { accessNote, footerNote, notReading, readingNote } from "../../src/access-note";

test("the footer says what is true of the service the page talks to", () => {
  // The installed service is locked: the footer says so, and does not call itself a development build.
  expect(accessNote("key")).toBe("Runs on this computer only · The owner lock is on");
  expect(accessNote("key")).not.toContain("development");
  expect(accessNote("key")).not.toContain("not configured");
  // The development API is open, and the page never calls itself a development build.
  expect(accessNote("open")).toBe("");
  // Before the service has answered, or when it cannot (the preview server, a stopped service),
  // nothing is claimed either way: a hosted page must never say, even for a moment, that it runs on this computer.
  expect(accessNote(undefined)).toBe("");
});

test("the footer says it is reading the books, and about how long, in the words the command line uses", () => {
  expect(readingNote(null)).toBe("Reading your books");
  expect(readingNote(0)).toBe("Reading your books, almost done");
  expect(readingNote(4.9)).toBe("Reading your books, almost done");
  expect(readingNote(5)).toBe("Reading your books, about 5 seconds");
  expect(readingNote(41)).toBe("Reading your books, about 40 seconds");
  expect(readingNote(57)).toBe("Reading your books, about 55 seconds");
  expect(readingNote(58)).toBe("Reading your books, about a minute");
  expect(readingNote(89)).toBe("Reading your books, about a minute");
  expect(readingNote(240)).toBe("Reading your books, about 4 minutes");
  expect(readingNote(3 * 3600)).toBe("Reading your books, about 3 hours");
});

test("the footer puts what the service is doing about the books before who can use it", () => {
  const reading = { reading: true, secondsLeft: 41, failure: null };
  expect(footerNote("key", reading)).toBe(
    "Reading your books, about 40 seconds · Runs on this computer only · The owner lock is on",
  );
  expect(footerNote(undefined, { reading: true, secondsLeft: null, failure: null })).toBe(
    "Reading your books",
  );
  // A service that could not read them says so, and where to look.
  expect(footerNote("key", { reading: false, secondsLeft: null, failure: "damaged" })).toBe(
    "Your books could not be read: run rastrata doctor in a terminal · Runs on this computer only · The owner lock is on",
  );
  // Not reading, or not known: the footer is what it always was.
  expect(footerNote("key", notReading)).toBe(accessNote("key"));
  expect(footerNote("open")).toBe(accessNote("open"));
});

test("signed in to a hosted service, the footer says who, and not that it runs on this computer", () => {
  expect(accessNote("key", true)).toBe("Signed in as the owner");
  expect(footerNote("key", notReading, true)).toBe("Signed in as the owner");
  expect(footerNote("key", { reading: true, secondsLeft: null, failure: null }, true)).toBe(
    "Reading your books · Signed in as the owner",
  );
  // Not signed in to one: as before.
  expect(footerNote("key", notReading, false)).toBe(accessNote("key"));
});

test("on a service with accounts the footer says who is signed in and as what, and nothing about an owner key", () => {
  const ann = { email: "ann@example.com", role: "owner" } as const;
  expect(accessNote("key", true, ann)).toBe("Signed in as ann@example.com · Owner");
  expect(accessNote(undefined, true, { email: "bob@example.com", role: "accountant" })).toBe(
    "Signed in as bob@example.com · Accountant",
  );
  // Before the workspace has said what the role is, the address is enough.
  expect(accessNote("key", true, { email: "ann@example.com" })).toBe(
    "Signed in as ann@example.com",
  );
  expect(footerNote("key", { reading: true, secondsLeft: null, failure: null }, true, ann)).toBe(
    "Reading your books · Signed in as ann@example.com · Owner",
  );
  expect(footerNote("key", notReading, true, ann)).not.toContain("owner key");
});
