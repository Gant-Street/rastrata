import { expect, test } from "bun:test";
import { mergeNameAndMemo } from "../../src/statements/ofx.ts";
import { assertWellFormed, bytesOf, fixtureBytes, fixtureText, parse } from "./helpers.ts";

const wrap = (statements: string, extra = "") =>
  `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n\n<OFX>\n<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20260228120000<LANGUAGE>ENG${extra}</SONRS></SIGNONMSGSRSV1>\n${statements}</OFX>\n`;
const bank = (
  account: string,
  transactions: string,
  tail = "<LEDGERBAL><BALAMT>100.00<DTASOF>20260228</LEDGERBAL>",
  bankId = "123456789",
) =>
  `<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>${bankId}<ACCTID>${account}<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>20260101<DTEND>20260228\n${transactions}</BANKTRANLIST>${tail}</STMTRS></STMTTRNRS></BANKMSGSRSV1>\n`;
const trn = (date: string, amount: string, id: string, name = "PAYEE", memo = "", type = "DEBIT") =>
  `<STMTTRN><TRNTYPE>${type}<DTPOSTED>${date}<TRNAMT>${amount}<FITID>${id}<NAME>${name}${memo ? `<MEMO>${memo}` : ""}</STMTTRN>\n`;

test("OFX 1.x SGML (leaf tags never closed) and OFX 2.x XML read to the same lines", () => {
  const sgml = parse(fixtureBytes("chase-checking.qfx"));
  const xml = parse(fixtureBytes("generic-ofx2.ofx"));
  assertWellFormed(sgml);
  assertWellFormed(xml);
  expect(sgml.ofx?.version).toBe("1");
  expect(xml.ofx?.version).toBe("2");
  const key = (result: typeof sgml) =>
    result.lines.map(({ line }) => `${line.postedOn} ${line.amount}`);
  expect(key(sgml)).toEqual(key(xml));
  expect(sgml.lines.every(({ line }) => line.provider === "ofx")).toBe(true);
  expect(sgml.lines.every(({ line }) => line.providerId !== undefined)).toBe(true);
});

test("the account key never holds the full account number, and is the same for an OFX, QFX or QBO file of one account", () => {
  const result = parse(fixtureBytes("chase-checking.qfx"));
  const key = result.accountKey as string;
  expect(key).toMatch(/^ofx:123456789:1234-[0-9a-f]{8}$/);
  expect(key).not.toContain("XXXXXXXXX");
  const renamed = parse(bytesOf(fixtureText("chase-checking.qfx")));
  expect(renamed.accountKey).toBe(key);
  const other = parse(
    bytesOf(fixtureText("chase-checking.qfx").replaceAll("XXXXXXXXX1234", "XXXXXXXXX9234")),
  );
  expect(other.accountKey).not.toBe(key);
});

test("NAME and MEMO are kept once: the longer text when one holds the other, both when they differ", () => {
  expect(mergeNameAndMemo("STRIPE TRANSFER ST-8K", "STRIPE TRANSFER ST-8KD3P1")).toBe(
    "STRIPE TRANSFER ST-8KD3P1",
  );
  expect(mergeNameAndMemo("GITHUB INC", "")).toBe("GITHUB INC");
  expect(mergeNameAndMemo("", "memo only")).toBe("memo only");
  expect(mergeNameAndMemo("GITHUB INC", "github inc")).toBe("GITHUB INC");
  expect(mergeNameAndMemo("ACME", "Invoice 77")).toBe("ACME Invoice 77");
  const result = parse(fixtureBytes("chase-checking.qfx"));
  expect(result.lines[0]?.line.description).toBe("STRIPE TRANSFER ST-8KD3P1");
  expect(result.lines[0]?.line.counterparty).toBe(
    "STRIPE TRANSFER ST-8KD3P1".slice(0, 32).trimEnd(),
  );
});

test("the ledger balance becomes a balance check, not an entry, and a card's owed balance stays negative", () => {
  const checking = parse(fixtureBytes("chase-checking.qfx"));
  expect(checking.balances).toHaveLength(1);
  expect(checking.balances[0]?.asOf).toBe("2026-02-28");
  const card = parse(fixtureBytes("chase-card.qfx"));
  expect(card.balances[0]?.balance.startsWith("-")).toBe(true);
  expect(card.ofx?.accounts[0]?.type).toBe("card");
  // An issuer that reports what is owed as a positive number is read correctly when told.
  const flipped = parse(fixtureBytes("chase-card.qfx"), { invertBalance: true });
  const owed = card.balances[0]?.balance ?? "";
  expect(flipped.balances[0]?.balance).toBe(owed.slice(1));
});

test("a bank that answers with an error is an error, not an empty statement", () => {
  const text = wrap("", "").replace(
    "<CODE>0<SEVERITY>INFO",
    "<CODE>2000<SEVERITY>ERROR<MESSAGE>Account is locked",
  );
  const result = parse(text);
  expect(result.lines).toHaveLength(0);
  expect(result.diagnostics.counts.errors).toBeGreaterThan(0);
  expect(result.diagnostics.list()[0]?.message).toContain("Account is locked");
});

test("text that has no OFX in it, and files with no statement, are refused plainly", () => {
  expect(parse("<OFX></OFX>").diagnostics.count("no_statement")).toBe(1);
  expect(parse("<html><body>hello</body></html>").format).toBe("csv");
  const empty = parse(wrap(""));
  expect(empty.diagnostics.count("no_statement")).toBe(1);
  expect(empty.lines).toHaveLength(0);
});

test("a file with several accounts needs one chosen, and says which exist", () => {
  const text = wrap(
    bank("ACCT0001", trn("20260102", "-5.00", "A1")) +
      bank("ACCT0002", trn("20260103", "-6.00", "B1")),
  );
  const result = parse(text);
  expect(result.lines).toHaveLength(0);
  expect(result.diagnostics.count("multiple_accounts")).toBe(1);
  expect(result.ofx?.accounts).toHaveLength(2);
  const chosen = parse(text, { ofxAccount: result.ofx?.accounts[1]?.key as string });
  expect(chosen.diagnostics.counts.errors).toBe(0);
  expect(chosen.lines.map(({ line }) => line.amount)).toEqual(["-6.00"]);
  // Raw indexes count every transaction in the file, so they do not move when another account is chosen.
  expect(chosen.lines[0]?.line.rawIndex).toBe(1);
  const unknown = parse(text, { ofxAccount: "ofx:nope" });
  expect(unknown.diagnostics.count("unknown_account")).toBe(1);
});

test("the same FITID twice: an exact repeat is skipped, two different transactions are an error", () => {
  const repeated = parse(
    wrap(bank("A", trn("20260102", "-5.00", "ID1") + trn("20260102", "-5.00", "ID1"))),
  );
  expect(repeated.lines).toHaveLength(1);
  expect(repeated.diagnostics.count("repeated_fitid")).toBe(1);
  expect(repeated.diagnostics.counts.errors).toBe(0);
  const conflict = parse(
    wrap(bank("A", trn("20260102", "-5.00", "ID1") + trn("20260103", "-9.00", "ID1"))),
  );
  expect(conflict.diagnostics.count("fitid_conflict")).toBe(1);
  expect(conflict.diagnostics.counts.errors).toBe(1);
  // A bank that reuses ids can still be imported, by ignoring them and relying on overlap detection.
  const ignored = parse(
    wrap(bank("A", trn("20260102", "-5.00", "ID1") + trn("20260103", "-9.00", "ID1"))),
    { ignoreProviderIds: true },
  );
  expect(ignored.diagnostics.counts.errors).toBe(0);
  expect(ignored.lines).toHaveLength(2);
  expect(ignored.lines.every(({ line }) => line.providerId === undefined)).toBe(true);
});

test("unreadable transactions are dropped with the number of the transaction, never imported half-read", () => {
  const text = wrap(
    bank(
      "A",
      trn("20260102", "-5.00", "ID1") +
        trn("20261301", "-5.00", "ID2") +
        trn("20260103", "12.345", "ID3") +
        trn("20260104", "abc", "ID4") +
        trn("20260105", "0.00", "ID5") +
        `<STMTTRN><TRNTYPE>DEBIT<TRNAMT>-5.00<FITID>ID6<NAME>NO DATE</STMTTRN>\n` +
        `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260106<FITID>ID7<NAME>NO AMOUNT</STMTTRN>\n` +
        trn("20260107", "-7.00", "ID8"),
    ),
  );
  const result = parse(text);
  assertWellFormed(result);
  expect(result.lines.map(({ line }) => line.providerId)).toEqual(["ID1", "ID8"]);
  const errors = result.diagnostics.list().filter((item) => item.severity === "error");
  expect(errors.map((item) => item.row)).toEqual([2, 3, 4, 6, 7]);
  expect(errors[1]?.message).toContain("more than two decimal places");
  expect(result.diagnostics.count("zero_amount")).toBe(1);
});

test("a type that disagrees with the sign is reported once, and the sign wins", () => {
  const text = wrap(
    bank(
      "A",
      trn("20260102", "5.00", "ID1", "X", "", "DEBIT") +
        trn("20260103", "6.00", "ID2", "Y", "", "DEBIT") +
        trn("20260104", "-7.00", "ID3", "Z", "", "CREDIT"),
    ),
  );
  const result = parse(text);
  expect(result.lines.map(({ line }) => line.amount)).toEqual(["5.00", "6.00", "-7.00"]);
  expect(result.diagnostics.count("type_sign")).toBe(1);
  expect(
    result.diagnostics.list().find((item) => item.message.includes("disagrees"))?.message,
  ).toContain("3 transactions");
});

test("entities, CDATA, lowercase tags, attributes and processing instructions are handled", () => {
  const xml = `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="211"?><ofx><bankmsgsrsv1><stmttrnrs><stmtrs><curdef>USD</curdef><bankacctfrom><bankid>1</bankid><acctid>9999</acctid><accttype>CHECKING</accttype></bankacctfrom><banktranlist><stmttrn><trntype>DEBIT</trntype><dtposted>20260102</dtposted><trnamt>-5.00</trnamt><fitid>1</fitid><name>AT&amp;T &lt;PAY&gt; &#65;&#x42;</name><memo><![CDATA[Cash & <carry>]]></memo></stmttrn></banktranlist></stmtrs></stmttrnrs></bankmsgsrsv1></ofx>`;
  const result = parse(xml);
  expect(result.diagnostics.counts.errors).toBe(0);
  expect(result.lines[0]?.line.description).toBe("AT&T <PAY> AB Cash & <carry>");
  // An unescaped ampersand, as SGML exporters write it, is kept as written.
  const sgml = parse(wrap(bank("A", trn("20260102", "-5.00", "1", "AT&T PAY"))));
  expect(sgml.lines[0]?.line.description).toBe("AT&T PAY");
});

test("a Windows-1252 file declared as such decodes its accents; UTF-8 declared as 1252 is not mangled", () => {
  const latin = new Uint8Array(
    [...bytesOf(wrap(bank("A", trn("20260102", "-5.00", "1", "CAFE_PLACEHOLDER"))))].map(
      (byte) => byte,
    ),
  );
  const text = new TextDecoder().decode(latin).replace("CAFE_PLACEHOLDER", "CAFÉ");
  const bytes1252 = new Uint8Array(
    [...text].map((symbol) => (symbol === "É" ? 0xc9 : symbol.charCodeAt(0))),
  );
  expect(parse(bytes1252).lines[0]?.line.description).toBe("CAFÉ");
  expect(parse(bytesOf(text)).lines[0]?.line.description).toBe("CAFÉ");
});

test("a transaction's raw text is kept as provenance, bounded", () => {
  const result = parse(fixtureBytes("chase-checking.qfx"));
  const excerpt = result.lines[0]?.line.excerpt as string;
  expect(excerpt.startsWith("<STMTTRN>")).toBe(true);
  expect(excerpt).toContain("<FITID>");
  expect(excerpt).toContain("</STMTTRN>");
});

test("a statement with an unclosed empty tag still finds the fields that follow it", () => {
  const text = wrap(
    bank(
      "A",
      "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260102<TRNAMT>-5.00<FITID>1<SIC><NAME>AFTER EMPTY</STMTTRN>\n",
    ),
  );
  const result = parse(text);
  expect(result.lines[0]?.line.description).toBe("AFTER EMPTY");
});

test("investment accounts are not imported and the file says so", () => {
  const text = wrap(
    `${bank("A", trn("20260102", "-5.00", "1"))}<INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><DTASOF>20260228<CURDEF>USD<INVACCTFROM><BROKERID>x<ACCTID>y</INVACCTFROM></INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1>\n`,
  );
  const result = parse(text);
  expect(result.lines).toHaveLength(1);
  expect(result.diagnostics.count("investment")).toBe(1);
});

test("a currency that is not a code is refused; a missing one falls back to the book's, with a note", () => {
  const missing = parse(wrap(bank("A", trn("20260102", "-5.00", "1"))).replace("<CURDEF>USD", ""));
  expect(missing.lines[0]?.line.currency).toBe("USD");
  expect(missing.diagnostics.count("no_currency")).toBe(1);
  const bad = parse(
    wrap(bank("A", trn("20260102", "-5.00", "1"))).replace("<CURDEF>USD", "<CURDEF>US DOLLARS"),
  );
  expect(bad.diagnostics.count("bad_currency")).toBe(1);
  expect(bad.lines).toHaveLength(0);
});
