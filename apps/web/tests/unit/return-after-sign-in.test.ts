// Where a person goes once they have signed in again because a page asked them to (src/return-after-sign-in.ts).
import { expect, test } from "bun:test";
import { returnAfterSignIn, takeReturnPath } from "../../src/return-after-sign-in";

function storage(): Storage {
  const kept = new Map<string, string>();
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
    clear: () => kept.clear(),
    key: () => null,
    get length() {
      return kept.size;
    },
  };
}

test("the page a person was sent from is where they go back to, once", () => {
  const tab = storage();
  expect(takeReturnPath(tab)).toBeNull();
  returnAfterSignIn("/settings/agent", tab);
  expect(takeReturnPath(tab)).toBe("/settings/agent");
  // It is taken as it is read: the sign-in after that goes where every sign-in goes.
  expect(takeReturnPath(tab)).toBeNull();
});

test("only a plain path of this application is kept or taken: never another site, a query, a fragment or a script", () => {
  for (const wrong of [
    "https://evil.example/settings/agent",
    "//evil.example",
    "/\\evil.example",
    "/settings/agent?next=https://evil.example",
    "/settings/agent#x",
    "javascript:alert(1)",
    "settings/agent",
    "/",
    "",
    "/Settings/Agent",
    "/settings//agent",
    "/settings/agent/",
  ]) {
    const tab = storage();
    returnAfterSignIn(wrong, tab);
    expect(takeReturnPath(tab), wrong).toBeNull();
    // Something else wrote it: it is still not taken, and it is cleared.
    tab.setItem("rastrata:return-to", wrong);
    expect(takeReturnPath(tab), wrong).toBeNull();
    expect(tab.getItem("rastrata:return-to")).toBeNull();
  }
});

test("a browser that keeps nothing sends the person to Home, as before", () => {
  const refusing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  } as unknown as Storage;
  expect(() => returnAfterSignIn("/settings/agent", refusing)).not.toThrow();
  expect(takeReturnPath(refusing)).toBeNull();
});
