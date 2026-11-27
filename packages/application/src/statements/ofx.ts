import type { BalanceCheck, BankLine } from "../ingest-types.ts";
import { formatMoney } from "../money.ts";
import { amountProblem, parseAmount } from "./amounts.ts";
import { parseOfxDate } from "./dates.ts";
import type { Diagnostics } from "./diagnostics.ts";
import { FLAG_MESSAGE, hostileFlags, quoteCell, truncateText } from "./hostile.ts";
import type { StatementLine } from "./csv-mapping.ts";
import { sha256Hex } from "./sha256.ts";

/** Open Financial Exchange: OFX 1.x (SGML, where leaf tags are never closed), OFX 2.x (XML), and
 * the Intuit flavours QFX and QBO, which are OFX with a few extra tags.
 *
 * One tolerant reader handles all of them. It builds a tree from tags and text, then reads bank and
 * credit-card statements out of it. It never throws, it bounds depth and node count, and every
 * problem becomes a diagnostic that names the transaction it is about. */

const MAX_NODES = 500_000;
const MAX_DEPTH = 40;
const EXCERPT_LIMIT = 4096;

interface Node {
  readonly name: string;
  text: string;
  readonly children: Node[];
  /** Offsets of the element in the decoded text, for the raw excerpt. */
  readonly start: number;
  end: number;
}

/** Tags that hold a value and may be empty. Any other tag with nothing but a tag after it opens an
 * aggregate. */
const LEAVES = new Set([
  "TRNTYPE",
  "DTPOSTED",
  "DTUSER",
  "DTAVAIL",
  "TRNAMT",
  "FITID",
  "CORRECTFITID",
  "CORRECTACTION",
  "SRVRTID",
  "CHECKNUM",
  "REFNUM",
  "SIC",
  "PAYEEID",
  "NAME",
  "MEMO",
  "CURDEF",
  "CURRATE",
  "CURSYM",
  "BANKID",
  "BRANCHID",
  "ACCTID",
  "ACCTTYPE",
  "ACCTKEY",
  "DTSTART",
  "DTEND",
  "BALAMT",
  "DTASOF",
  "TRNUID",
  "CODE",
  "SEVERITY",
  "MESSAGE",
  "DTSERVER",
  "LANGUAGE",
  "ORG",
  "FID",
  "INTU.BID",
  "INTU.USERID",
  "USERID",
  "CLTCOOKIE",
  "ADDR1",
  "ADDR2",
  "ADDR3",
  "CITY",
  "STATE",
  "POSTALCODE",
  "COUNTRY",
  "PHONE",
  "TRNTYPE2",
]);

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the five XML entities and numeric references. Anything else, such as a bare `&` that an
 * SGML exporter forgot to escape, is kept as written. */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/g,
    (whole, body: string) => {
      if (body.startsWith("#")) {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number(body.slice(1));
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES[body.toLowerCase()] ?? whole;
    },
  );
}

interface Tree {
  readonly root: Node;
  readonly nodes: number;
  readonly truncated: boolean;
  /** Tags that closed something that was never opened. */
  readonly stray: number;
}

/** Everything from the first `<OFX>` on, as a tree. */
function buildTree(text: string): Tree {
  const root: Node = { name: "#root", text: "", children: [], start: 0, end: text.length };
  const stack: Node[] = [root];
  const begin = text.search(/<OFX[\s>]/i);
  let position = begin === -1 ? text.length : begin;
  let nodes = 0;
  let stray = 0;
  let truncated = false;
  /** An empty element just opened, which CDATA or a closing tag may still fill or close. */
  let pendingLeaf: Node | null = null;
  const length = text.length;
  while (position < length) {
    const open = text.indexOf("<", position);
    if (open === -1) break;
    // Processing instructions, comments and CDATA.
    if (text.startsWith("<?", open)) {
      const close = text.indexOf("?>", open + 2);
      position = close === -1 ? length : close + 2;
      continue;
    }
    if (text.startsWith("<!--", open)) {
      const close = text.indexOf("-->", open + 4);
      position = close === -1 ? length : close + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", open)) {
      const close = text.indexOf("]]>", open + 9);
      const body = text.slice(open + 9, close === -1 ? length : close);
      // CDATA is the value of the empty element it follows, or of the enclosing one.
      const owner = pendingLeaf ?? (stack[stack.length - 1] as Node);
      owner.text += body;
      position = close === -1 ? length : close + 3;
      continue;
    }
    const close = text.indexOf(">", open + 1);
    if (close === -1) break;
    const raw = text.slice(open + 1, close);
    position = close + 1;
    const waiting = pendingLeaf;
    pendingLeaf = null;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toUpperCase();
      if (waiting && waiting.name === name) {
        waiting.end = close + 1;
        continue;
      }
      let found = -1;
      for (let index = stack.length - 1; index > 0; index--)
        if ((stack[index] as Node).name === name) {
          found = index;
          break;
        }
      if (found === -1) {
        stray++;
        continue;
      }
      while (stack.length > found) {
        const done = stack.pop() as Node;
        done.end = close + 1;
      }
      continue;
    }
    // An opening tag. Attributes (XML flavours) are dropped; OFX tag names have none.
    const name = (raw.split(/[\s/]/, 1)[0] as string).toUpperCase();
    if (name === "" || !/^[A-Z0-9_.:-]{1,40}$/.test(name)) continue;
    if (++nodes > MAX_NODES) {
      truncated = true;
      break;
    }
    const next = text.indexOf("<", position);
    const value = text.slice(position, next === -1 ? length : next);
    const trimmed = value.trim();
    const parent = stack[stack.length - 1] as Node;
    const node: Node = { name, text: "", children: [], start: open, end: close + 1 };
    parent.children.push(node);
    const selfClosed = raw.endsWith("/");
    if (selfClosed) continue;
    if (trimmed !== "") {
      node.text = decodeEntities(trimmed);
      node.end = next === -1 ? length : next;
      position = next === -1 ? length : next;
      // A closing tag for the leaf itself, as in XML.
      const closer = `</${name}>`;
      if (text.substr(position, closer.length).toUpperCase() === closer) {
        position += closer.length;
        node.end = position;
      }
      continue;
    }
    const nextTag = text.slice(position + value.length, position + value.length + name.length + 3);
    const closesItself = nextTag.toUpperCase().startsWith(`</${name}>`);
    if (LEAVES.has(name) || closesItself) {
      if (closesItself) {
        position += value.length + name.length + 3;
        node.end = position;
      } else pendingLeaf = node;
      continue;
    }
    if (stack.length >= MAX_DEPTH) continue;
    stack.push(node);
  }
  for (const open of stack)
    if (open !== root && open.end < position) open.end = Math.min(position, length);
  return { root, nodes, truncated, stray };
}

/** The nearest element called `name` under `node`: a direct child wins over a deeper one, and
 * nothing is looked for more than three levels down. An exporter that forgets to close an empty
 * tag nests its siblings inside it; this still finds them. */
function find(node: Node | undefined, name: string, depth = 3): Node | undefined {
  if (!node) return undefined;
  let level: Node[] = [node];
  for (let step = 0; step <= depth && level.length > 0; step++) {
    const next: Node[] = [];
    for (const parent of level)
      for (const item of parent.children) {
        if (item.name === name) return item;
        next.push(item);
      }
    level = next;
  }
  return undefined;
}
const child = (node: Node, name: string): Node | undefined => find(node, name, 0);
const textOf = (node: Node | undefined, name: string): string => find(node, name)?.text ?? "";

function* descendants(node: Node, names: ReadonlySet<string>): Generator<Node> {
  const pending: Node[] = [node];
  while (pending.length > 0) {
    const current = pending.pop() as Node;
    if (names.has(current.name)) {
      yield current;
      continue;
    }
    for (let index = current.children.length - 1; index >= 0; index--)
      pending.push(current.children[index] as Node);
  }
}

export interface OfxAccount {
  /** The source key lines carry: stable, and free of the full account number. */
  readonly key: string;
  /** "Checking ••1234", for a person choosing among accounts. */
  readonly label: string;
  readonly type: "bank" | "card";
  /** The statement's own account type, such as CHECKING, SAVINGS or CREDITCARD. */
  readonly accountType: string;
  readonly currency: string;
  readonly lines: readonly StatementLine[];
  readonly balance: BalanceCheck | null;
  /** The first and last dates the statement says it covers, when it says. */
  readonly from: string | null;
  readonly to: string | null;
}

export interface OfxParse {
  readonly accounts: readonly OfxAccount[];
  readonly version: "1" | "2" | "unknown";
  /** The financial institution the file names, for display. */
  readonly institution: string | null;
  /** Transactions seen in the whole file, for stable raw indexes. */
  readonly transactions: number;
}

export interface OfxOptions {
  /** The book's currency, used when a statement names none. */
  readonly defaultCurrency: string;
  /** Ignore FITIDs: for a bank that reuses them. Lines then rely on overlap detection. */
  readonly ignoreProviderIds?: boolean;
  /** Flip the sign of the reported balance, for an issuer that reports what is owed as positive. */
  readonly invertBalance?: boolean;
}

const STATEMENTS = new Set(["STMTRS", "CCSTMTRS"]);
// Types whose direction is not in doubt. PAYMENT and INT are left out: a card's payment is money in,
// and interest is money in on a deposit account and money out on a card.
const DEBIT_TYPES = new Set([
  "DEBIT",
  "CHECK",
  "ATM",
  "POS",
  "FEE",
  "SRVCHG",
  "DIRECTDEBIT",
  "REPEATPMT",
  "CASH",
]);
const CREDIT_TYPES = new Set(["CREDIT", "DEP", "DIRECTDEP"]);

function safeToken(text: string, limit: number): string {
  return text.replace(/[^A-Za-z0-9._-]/g, "").slice(0, limit);
}

/** OFX has a short NAME (32 characters in the spec) and a MEMO. Banks repeat the one in the other
 * or split a long description across both. Keep everything the bank said, once: the longer text
 * when one contains the other, otherwise both, joined by a space. */
export function mergeNameAndMemo(name: string, memo: string): string {
  if (memo === "") return name;
  if (name === "") return memo;
  const lowerName = name.toLowerCase();
  const lowerMemo = memo.toLowerCase();
  if (lowerMemo === lowerName) return name;
  if (lowerMemo.includes(lowerName)) return memo;
  if (lowerName.includes(lowerMemo)) return name;
  return `${name} ${memo}`;
}

function describeAccount(type: "bank" | "card", accountType: string, accountId: string): string {
  const digits = accountId.replace(/[^A-Za-z0-9]/g, "");
  const tail = digits.length > 4 ? digits.slice(-4) : digits;
  const noun =
    type === "card"
      ? "Card"
      : accountType === "SAVINGS"
        ? "Savings"
        : accountType === "MONEYMRKT"
          ? "Money market"
          : accountType === "CREDITLINE"
            ? "Credit line"
            : "Checking";
  return tail === "" ? noun : `${noun} ••${tail}`;
}

/** Read the text of an OFX file. */
export function parseOfxText(
  text: string,
  options: OfxOptions,
  diagnostics: Diagnostics,
): OfxParse {
  const header = /OFXHEADER\s*[:=]\s*"?([0-9]+)/i.exec(text.slice(0, 2048));
  const versionAttr = /VERSION\s*[:=]\s*"?([0-9]+)/i.exec(text.slice(0, 2048));
  const xml = /<\?xml/i.test(text.slice(0, 512)) || /<\?OFX/i.test(text.slice(0, 2048));
  const version: OfxParse["version"] =
    xml || (header?.[1] ?? "").startsWith("2") || (versionAttr?.[1] ?? "").startsWith("2")
      ? "2"
      : header || versionAttr
        ? "1"
        : "unknown";
  const tree = buildTree(text);
  if (tree.truncated)
    diagnostics.error(
      "too_large",
      "The file has more elements than can be read safely; split it into shorter periods",
    );
  if (tree.stray > 0)
    diagnostics.warning(
      "stray_tags",
      `${tree.stray} closing tag${tree.stray === 1 ? "" : "s"} did not match anything open and ${tree.stray === 1 ? "was" : "were"} ignored`,
    );
  const ofx = child(tree.root, "OFX");
  if (!ofx) {
    diagnostics.error("not_ofx", "This does not look like an OFX file: there is no <OFX> element");
    return { accounts: [], version, institution: null, transactions: 0 };
  }
  // The bank may answer with an error instead of a statement.
  for (const status of descendants(ofx, new Set(["STATUS"]))) {
    const severity = textOf(status, "SEVERITY").toUpperCase();
    const code = textOf(status, "CODE");
    if (severity === "ERROR" || (code !== "" && code !== "0"))
      diagnostics.error(
        "bank_error",
        `The file reports an error from the bank (code ${quoteCell(code, 12)}): ${quoteCell(textOf(status, "MESSAGE"), 120)}`,
      );
    else if (severity === "WARN")
      diagnostics.warning(
        "bank_warning",
        `The bank added a warning: ${quoteCell(textOf(status, "MESSAGE"), 120)}`,
      );
  }
  const fi = descendants(ofx, new Set(["FI"])).next().value as Node | undefined;
  const institution = fi ? safeToken(textOf(fi, "ORG").trim(), 60) || null : null;
  const accounts: OfxAccount[] = [];
  let ordinal = 0;
  const invested = [...descendants(ofx, new Set(["INVSTMTRS"]))].length;
  if (invested > 0)
    diagnostics.warning(
      "investment",
      "This file also holds an investment account; investment statements are not imported",
    );
  for (const statement of descendants(ofx, STATEMENTS)) {
    const isCard = statement.name === "CCSTMTRS";
    const from = child(statement, isCard ? "CCACCTFROM" : "BANKACCTFROM");
    const accountId = textOf(from, "ACCTID");
    const bankId = textOf(from, "BANKID");
    const accountType =
      safeToken(textOf(from, "ACCTTYPE").toUpperCase(), 20) || (isCard ? "CREDITCARD" : "CHECKING");
    if (accountId === "")
      diagnostics.warning(
        "no_account_id",
        "A statement in this file has no account number; its lines are kept under an unnamed account",
      );
    const type: "bank" | "card" = isCard ? "card" : "bank";
    const prefix = safeToken(bankId || institution || (isCard ? "card" : "bank"), 20) || "x";
    const tail = safeToken(accountId.slice(-4), 4) || "none";
    const key = `ofx:${prefix}:${tail}-${sha256Hex(`${bankId}|${accountId}`).slice(0, 8)}`;
    const currency = (textOf(statement, "CURDEF") || options.defaultCurrency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      diagnostics.error(
        "bad_currency",
        `The statement's currency ${quoteCell(currency, 12)} is not a three-letter code`,
      );
      continue;
    }
    if (textOf(statement, "CURDEF") === "")
      diagnostics.warning(
        "no_currency",
        `The statement names no currency; ${options.defaultCurrency} was assumed`,
      );
    const list = child(statement, "BANKTRANLIST");
    const lines: StatementLine[] = [];
    const seenIds = new Map<string, { posted: string; amount: string; row: number }>();
    let typeMismatch = 0;
    let firstMismatch = 0;
    for (const transaction of list ? descendants(list, new Set(["STMTTRN"])) : []) {
      const row = ++ordinal;
      const rawIndex = row - 1;
      const dateText = textOf(transaction, "DTPOSTED");
      let posted = dateText === "" ? null : parseOfxDate(dateText);
      if (posted === null && dateText === "") {
        const fallback = textOf(transaction, "DTUSER");
        if (fallback !== "") {
          posted = parseOfxDate(fallback);
          if (posted)
            diagnostics.warning(
              "posted_from_user_date",
              "The transaction has no posted date; the date the customer entered was used",
              row,
            );
        }
      }
      if (posted === null) {
        diagnostics.error(
          "bad_row",
          dateText === ""
            ? "Transaction skipped: it has no posted date"
            : `Transaction skipped: the date ${quoteCell(dateText)} is not a date`,
          row,
        );
        continue;
      }
      const amountText = textOf(transaction, "TRNAMT");
      const amount = parseAmount(amountText);
      if (!amount.ok) {
        diagnostics.error(
          "bad_row",
          amountText === ""
            ? "Transaction skipped: it has no amount"
            : `Transaction skipped: the amount ${quoteCell(amountText)} ${amountProblem(amount.error)}`,
          row,
        );
        continue;
      }
      if (amount.cents === 0n) {
        diagnostics.info("zero_amount", "Skipped a transaction whose amount is 0.00", row);
        continue;
      }
      const fitid = textOf(transaction, "FITID");
      if (fitid.length > 255) {
        diagnostics.error(
          "bad_row",
          "Transaction skipped: its FITID is longer than the 255 characters OFX allows",
          row,
        );
        continue;
      }
      const name = textOf(transaction, "NAME");
      const memo = textOf(transaction, "MEMO");
      const rawDescription = mergeNameAndMemo(name.trim(), memo.trim());
      const description = truncateText(rawDescription);
      if (description.cut)
        diagnostics.warning(
          "text_cut",
          "The description is longer than 1000 characters and was cut; the raw file keeps all of it",
          row,
        );
      for (const flag of hostileFlags(rawDescription))
        diagnostics.warning(`hostile_${flag}`, `The description ${FLAG_MESSAGE[flag]}`, row);
      const reference = (textOf(transaction, "CHECKNUM") || textOf(transaction, "REFNUM")).trim();
      const counterparty = truncateText(name.trim(), 200).text;
      const trnType = textOf(transaction, "TRNTYPE").toUpperCase();
      if (
        (DEBIT_TYPES.has(trnType) && amount.cents > 0n) ||
        (CREDIT_TYPES.has(trnType) && amount.cents < 0n)
      ) {
        typeMismatch++;
        if (firstMismatch === 0) firstMismatch = row;
      }
      let providerId: string | undefined;
      if (fitid !== "" && !options.ignoreProviderIds) {
        const earlier = seenIds.get(fitid);
        if (earlier) {
          if (earlier.posted === posted && earlier.amount === amount.text) {
            diagnostics.warning(
              "repeated_fitid",
              `The same transaction (id ${quoteCell(fitid, 30)}) is listed again; the repeat was skipped`,
              row,
            );
          } else {
            diagnostics.error(
              "fitid_conflict",
              `The bank gave the id ${quoteCell(fitid, 30)} to two different transactions (this one and the one at row ${earlier.row}). Import again with the option to ignore the bank's ids.`,
              row,
            );
          }
          continue;
        }
        seenIds.set(fitid, { posted, amount: amount.text, row });
        providerId = fitid;
      } else if (fitid === "" && !options.ignoreProviderIds) {
        diagnostics.warning(
          "no_fitid",
          "The transaction has no id (FITID); it can only be told from a repeat by its date, amount and text",
          row,
        );
      }
      if (
        transaction.children.some(
          (item) => item.name === "CURRENCY" || item.name === "ORIGCURRENCY",
        )
      )
        diagnostics.info(
          "foreign_amount",
          "The transaction carries a foreign currency amount; the raw file keeps it",
          row,
        );
      const excerptEnd = Math.min(transaction.end, transaction.start + EXCERPT_LIMIT);
      const excerpt = text.slice(transaction.start, excerptEnd);
      const line: BankLine = {
        kind: "bankLine",
        provider: "ofx",
        accountKey: key,
        rawIndex,
        postedOn: posted,
        amount: formatMoney(amount.cents),
        currency,
        description: description.text,
        ...(counterparty !== "" ? { counterparty } : {}),
        ...(reference !== "" ? { reference: truncateText(reference, 100).text } : {}),
        ...(providerId !== undefined ? { providerId } : {}),
        ...(excerpt !== "" ? { excerpt } : {}),
      };
      lines.push({ line, row });
    }
    if (typeMismatch > 0)
      diagnostics.warning(
        "type_sign",
        `${typeMismatch} transaction${typeMismatch === 1 ? "" : "s"} have a type (debit or credit) that disagrees with the sign of the amount, starting at row ${firstMismatch}. The sign of the amount was used.`,
        firstMismatch,
      );
    // The ledger balance becomes a check, not an entry.
    let balance: BalanceCheck | null = null;
    const ledger = child(statement, "LEDGERBAL");
    if (ledger) {
      const reported = parseAmount(textOf(ledger, "BALAMT"));
      const asOf = parseOfxDate(textOf(ledger, "DTASOF"));
      if (!reported.ok)
        diagnostics.warning(
          "bad_balance",
          `The statement balance ${quoteCell(textOf(ledger, "BALAMT"))} ${amountProblem(reported.error)}; no balance check was made`,
        );
      else if (asOf === null)
        diagnostics.warning(
          "bad_balance",
          "The statement balance has no usable date; no balance check was made",
        );
      else
        balance = {
          accountKey: key,
          asOf,
          balance: formatMoney(options.invertBalance ? -reported.cents : reported.cents),
        };
    }
    accounts.push({
      key,
      label: describeAccount(type, accountType, accountId),
      type,
      accountType,
      currency,
      lines,
      balance,
      from: parseOfxDate(textOf(list, "DTSTART")),
      to: parseOfxDate(textOf(list, "DTEND")),
    });
  }
  if (accounts.length === 0 && diagnostics.counts.errors === 0)
    diagnostics.error("no_statement", "There is no bank or credit card statement in this file");
  return { accounts, version, institution, transactions: ordinal };
}
