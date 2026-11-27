import { expect, test } from "bun:test";
import {
  describeCredential,
  isAllowedHost,
  memoryCredentialStore,
  parseAccessUrl,
  parseSetupToken,
} from "../../src/bankfeed/credentials.ts";
import { FIXTURE_PASSWORD, FIXTURE_USER, fakeBridge } from "./fake-bridge.ts";

const strict = { allowLoopback: false } as const;
const loopback = { allowLoopback: true } as const;
const tokenOf = (url: string): string => btoa(url);

// ---- the setup token ---------------------------------------------------------------------------

test("a setup token is base64 of the claim URL, and it is read once checked", () => {
  const bridge = fakeBridge();
  const parsed = parseSetupToken(bridge.setupToken(), strict);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.claimUrl).toBe(
      "https://beta-bridge.simplefin.org/simplefin/claim/FIXTURE-2026-A1B2C3D4",
    );
  }
});

test("whitespace and line breaks a person copies along are ignored, and the url-safe alphabet is read", () => {
  const url = "https://beta-bridge.simplefin.org/simplefin/claim/AB-CD_EF.12";
  const plain = tokenOf(url);
  const split = `  ${plain.slice(0, 20)}\n${plain.slice(20)}\r\n`;
  expect(parseSetupToken(split, strict).ok).toBe(true);
  const urlSafe = plain.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect(parseSetupToken(urlSafe, strict).ok).toBe(true);
});

test("text that is not a setup token is refused, and the message never repeats it", () => {
  const secretLooking = "not-a-token-but-has-a-s3cr3t-in-it";
  for (const bad of [
    "",
    "   ",
    "short",
    secretLooking,
    "https://beta-bridge.simplefin.org/simplefin/claim/AB-CD_EF.12",
    `"${tokenOf("https://beta-bridge.simplefin.org/simplefin/claim/AB-CD")}"`,
    tokenOf("not a url at all, just some words that are long enough"),
    tokenOf("https://beta-bridge.simplefin.org/simplefin/accounts"),
    tokenOf("https://beta-bridge.simplefin.org/simplefin/claim/"),
    tokenOf("https://beta-bridge.simplefin.org/simplefin/claim/ab"),
    "A".repeat(3000),
  ]) {
    const result = parseSetupToken(bad, strict);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("bankfeed_token_invalid");
      expect(result.message).not.toContain(secretLooking);
      expect(result.message).not.toContain(bad.trim().slice(0, 30) || "\u0000");
    }
  }
});

test("a token that points anywhere but the Bridge is refused before anything is sent", () => {
  for (const url of [
    "http://beta-bridge.simplefin.org/simplefin/claim/AB-CD-1234",
    "https://evil.example/simplefin/claim/AB-CD-1234",
    "https://simplefin.org.evil.example/simplefin/claim/AB-CD-1234",
    "https://evilsimplefin.org/simplefin/claim/AB-CD-1234",
    "https://beta-bridge.simplefin.org:8443/simplefin/claim/AB-CD-1234",
    "https://user:pass@beta-bridge.simplefin.org/simplefin/claim/AB-CD-1234",
    "https://beta-bridge.simplefin.org/simplefin/claim/AB-CD-1234?next=https://evil.example",
    "https://beta-bridge.simplefin.org/simplefin/claim/AB-CD-1234#frag",
    "https://127.0.0.1/simplefin/claim/AB-CD-1234",
    "https://localhost/simplefin/claim/AB-CD-1234",
    "https://169.254.169.254/latest/claim/AB-CD-1234",
    "ftp://beta-bridge.simplefin.org/simplefin/claim/AB-CD-1234",
  ]) {
    const result = parseSetupToken(tokenOf(url), strict);
    expect(result.ok).toBe(false);
  }
  const refused = parseSetupToken(
    tokenOf("https://evil.example/simplefin/claim/AB-CD-1234"),
    strict,
  );
  expect(refused.ok === false && refused.code).toBe("bankfeed_host_refused");
  expect(refused.ok === false && refused.message).not.toContain("evil.example");
});

test("simplefin.org and its sub-domains are the Bridge; a stand-in on this machine only when a test says so", () => {
  expect(isAllowedHost(new URL("https://beta-bridge.simplefin.org/x"), strict)).toBe(true);
  expect(isAllowedHost(new URL("https://bridge.simplefin.org/x"), strict)).toBe(true);
  expect(isAllowedHost(new URL("https://simplefin.org/x"), strict)).toBe(true);
  expect(isAllowedHost(new URL("https://x.simplefin.org.evil.test/x"), strict)).toBe(false);
  const local = tokenOf("http://127.0.0.1:5999/simplefin/claim/AB-CD-1234");
  expect(parseSetupToken(local, strict).ok).toBe(false);
  expect(parseSetupToken(local, loopback).ok).toBe(true);
  // Loopback is the only thing the test switch adds.
  expect(
    parseSetupToken(tokenOf("http://evil.example/simplefin/claim/AB-CD-1234"), loopback).ok,
  ).toBe(false);
  expect(parseSetupToken(tokenOf("http://10.0.0.5/simplefin/claim/AB-CD-1234"), loopback).ok).toBe(
    false,
  );
});

// ---- the access URL ----------------------------------------------------------------------------

test("an access URL is split: the credentials go in a Basic header, never in the URL", () => {
  const access = parseAccessUrl(fakeBridge().accessUrl(), strict);
  expect(access).not.toBeNull();
  if (!access) return;
  expect(access.base).toBe("https://beta-bridge.simplefin.org/simplefin");
  expect(access.base).not.toContain("@");
  expect(access.host).toBe("beta-bridge.simplefin.org");
  expect(access.authorization).toBe(`Basic ${btoa(`${FIXTURE_USER}:${FIXTURE_PASSWORD}`)}`);
  // Everything the credential can be spelled as is on the list used to scrub messages.
  for (const secret of [
    fakeBridge().accessUrl(),
    FIXTURE_USER,
    FIXTURE_PASSWORD,
    access.authorization,
    btoa(`${FIXTURE_USER}:${FIXTURE_PASSWORD}`),
  ])
    expect(access.secrets).toContain(secret);
});

test("credentials with reserved characters are decoded for the header and still scrubbed", () => {
  const access = parseAccessUrl(
    "https://us%40er-name-1:p%2Fss%3Aword%25@beta-bridge.simplefin.org/simplefin/",
    strict,
  );
  expect(access?.authorization).toBe(`Basic ${btoa("us@er-name-1:p/ss:word%")}`);
  expect(access?.base).toBe("https://beta-bridge.simplefin.org/simplefin");
});

test("an access URL needs HTTPS to the Bridge, a user and a password", () => {
  for (const bad of [
    "",
    "not a url",
    "https://beta-bridge.simplefin.org/simplefin",
    "https://user@beta-bridge.simplefin.org/simplefin",
    "https://:pass@beta-bridge.simplefin.org/simplefin",
    "http://user:pass@beta-bridge.simplefin.org/simplefin",
    "https://user:pass@evil.example/simplefin",
    "https://user:pass@beta-bridge.simplefin.org:8443/simplefin",
    "https://user:pass@beta-bridge.simplefin.org/simplefin?x=1",
    "https://user:pass%0A@beta-bridge.simplefin.org/simplefin",
    `https://${"u".repeat(3000)}:p@beta-bridge.simplefin.org/simplefin`,
  ])
    expect(parseAccessUrl(bad, strict)).toBeNull();
});

// ---- what may be said about a credential --------------------------------------------------------

test("a credential is described by whether it is there and which host, never by its value", () => {
  const empty = describeCredential(memoryCredentialStore(), strict);
  expect(empty).toEqual({ present: false, host: null, problem: null });

  const store = memoryCredentialStore(fakeBridge().accessUrl());
  const described = describeCredential(store, strict);
  expect(described).toEqual({ present: true, host: "beta-bridge.simplefin.org", problem: null });
  expect(JSON.stringify(described)).not.toContain(FIXTURE_PASSWORD);
  expect(JSON.stringify(described)).not.toContain(FIXTURE_USER);

  const unusable = describeCredential(memoryCredentialStore("https://evil.example/x"), strict);
  expect(unusable.present).toBe(false);
  expect(unusable.problem).toContain("not usable");
  expect(unusable.problem).not.toContain("evil.example");

  const failing = describeCredential(
    {
      read() {
        throw new Error(`could not read ${fakeBridge().accessUrl()}`);
      },
      probe: () => null,
      write() {},
      remove() {},
    },
    strict,
  );
  expect(failing.problem).toBe("The access URL could not be read.");
});

test("a test may name the one stand-in address it speaks to, and nothing else on this machine is reachable", () => {
  const only = { allowLoopback: true, onlyOrigin: "http://127.0.0.1:20240" } as const;
  expect(
    parseSetupToken(tokenOf("http://127.0.0.1:20240/simplefin/claim/AB-CD-1234"), only).ok,
  ).toBe(true);
  for (const other of [
    "http://127.0.0.1:20241/simplefin/claim/AB-CD-1234",
    "http://localhost:20240/simplefin/claim/AB-CD-1234",
    "http://127.0.0.1/simplefin/claim/AB-CD-1234",
    "http://10.0.0.5:20240/simplefin/claim/AB-CD-1234",
  ])
    expect(parseSetupToken(tokenOf(other), only).ok, other).toBe(false);
  expect(isAllowedHost(new URL("http://127.0.0.1:20240/simplefin"), only)).toBe(true);
  expect(isAllowedHost(new URL("http://127.0.0.1:20241/simplefin"), only)).toBe(false);
  // The Bridge itself is still allowed, and an access URL on the named origin reads.
  expect(isAllowedHost(new URL("https://beta-bridge.simplefin.org/simplefin"), only)).toBe(true);
  expect(
    parseAccessUrl("http://user-name-1:pass-word-1@127.0.0.1:20240/simplefin", only)?.base,
  ).toBe("http://127.0.0.1:20240/simplefin");
  expect(
    parseAccessUrl("http://user-name-1:pass-word-1@127.0.0.1:20241/simplefin", only),
  ).toBeNull();
});
