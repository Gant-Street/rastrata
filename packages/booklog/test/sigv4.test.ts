import { expect, test } from "bun:test";
import { amzDate, sha256Hex, signRequest, uriEncode } from "../src/sigv4.ts";

// Vectors produced by curl's own `--aws-sigv4` (an implementation that is not ours) for fake
// credentials against 127.0.0.1:18999, captured by experiments/sigv4-crosscheck.ts. Each is a
// request, a time and the signature curl computed for it.
const ACCESS = "AKIDEXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const DATE = new Date("2026-10-08T03:15:11Z");
const BODY = "hello entry";

const sign = (method: string, url: string, headers: Record<string, string>, body = ""): string =>
  signRequest({
    method,
    url: new URL(url),
    headers,
    payloadHash: sha256Hex(body),
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    region: "us-east-1",
    date: DATE,
  }).signature;

test("signatures equal the ones curl computes for the same requests", () => {
  const host = "http://127.0.0.1:18999";
  expect(sign("GET", `${host}/bucket/books/b1/log/000000000001`, {})).toBe(
    "363d2d4234b62e1a743855e80514189be58509b89483023f33ef3a93b76a8c35",
  );
  expect(
    sign(
      "PUT",
      `${host}/bucket/books/b1/log/000000000002`,
      { "if-none-match": "*", "content-type": "application/octet-stream" },
      BODY,
    ),
  ).toBe("3d670f568d41fef731366aeaf83fc60560d1270656cfad38dd26d2e6a3ab9e0b");
  expect(
    sign(
      "PUT",
      `${host}/bucket/runs/hoststore/r1/test%24file.text`,
      { "x-amz-meta-hash": "abc123", "x-amz-meta-prev": "000" },
      "x",
    ),
  ).toBe("a506823983bf186dc916d64154c76196097fdb30c58333e6ce79a5e0ca961324");
  expect(
    sign(
      "GET",
      `${host}/bucket?list-type=2&max-keys=2&prefix=books%2Fb1%2Flog%2F&start-after=books%2Fb1%2Flog%2F000000000001`,
      {},
    ),
  ).toBe("6a59c45726db93d60ec5bc05740622a799f8a8af48cb49c5f1c8a9196d7a2b71");
  expect(sign("HEAD", `${host}/bucket/a%20b/c`, {})).toBe(
    "6ee2a2f37069e6b4e1bde35cc05f1be7235461cb50831fb78cda7dfaaeab3adf",
  );
});

test("the signed headers and the credential scope are what S3 expects", () => {
  const signed = signRequest({
    method: "PUT",
    url: new URL("https://acct.r2.cloudflarestorage.com/bucket/k"),
    headers: { "If-None-Match": "*", "X-Amz-Meta-Hash": "h" },
    payloadHash: sha256Hex("x"),
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    region: "auto",
    date: DATE,
  });
  expect(signed.headers.authorization).toStartWith(
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261008/auto/s3/aws4_request, SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-meta-hash, Signature=",
  );
  expect(signed.headers["x-amz-date"]).toBe("20261008T031511Z");
  expect(signed.headers["x-amz-content-sha256"]).toBe(sha256Hex("x"));
  expect(signed.canonicalRequest.split("\n")[0]).toBe("PUT");
});

test("a session token is signed and sent", () => {
  const signed = signRequest({
    method: "GET",
    url: new URL("https://h.example/bucket/k"),
    headers: {},
    payloadHash: sha256Hex(""),
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    sessionToken: "token-value",
    region: "us-east-1",
    date: DATE,
  });
  expect(signed.headers["x-amz-security-token"]).toBe("token-value");
  expect(signed.headers.authorization).toContain("x-amz-security-token");
});

test("percent-encoding follows RFC 3986 and keeps slashes only in a path", () => {
  expect(uriEncode("a b/c~d_e-f.g")).toBe("a%20b%2Fc~d_e-f.g");
  expect(uriEncode("a b/c", true)).toBe("a%20b/c");
  expect(uriEncode("test$file.text", true)).toBe("test%24file.text");
  expect(uriEncode("é")).toBe("%C3%A9");
  expect(uriEncode("a+b=c&d")).toBe("a%2Bb%3Dc%26d");
});

test("the timestamp format is basic ISO 8601 without milliseconds", () => {
  expect(amzDate(new Date("2013-05-24T00:00:00.123Z"))).toBe("20130524T000000Z");
});
