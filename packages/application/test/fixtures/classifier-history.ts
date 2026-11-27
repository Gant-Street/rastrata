import type { TrainingExample } from "../../src/rules/classifier.ts";
import { random } from "./rules-kit.ts";

/** A synthetic but realistic bank history for a small online business (a one or two person company
 * that sells software through Stripe), used to measure the classifier. Eighteen months, about
 * fifteen hundred lines, booked to sixteen accounts.
 *
 * It is built to be hard in the ways real books are, so the numbers it produces are not flattering:
 * - memos carry store numbers, reference ids, dates, cities and a payment-rail prefix that change
 *   from one line to the next;
 * - several merchants are genuinely ambiguous (Amazon is office supplies, equipment, groceries and
 *   books; Costco is groceries or supplies; Google is G Suite, advertising or cloud; Uber is rides
 *   or food);
 * - a vendor appears for the first time halfway through, and some appear once and never again;
 * - two lines in a hundred are booked by a person to the wrong account, the way a tired person does.
 *
 * Merchant names are public company names used only as text. No amount, balance or identifier is a
 * real person's or business's. A seeded generator means the same fixture on every run. */

export const ACCOUNTS: Readonly<Record<string, string>> = {
  revenue: "4000",
  interest: "4100",
  software: "6100",
  hosting: "6200",
  meals: "6300",
  travel: "6400",
  office: "6500",
  fees: "6600",
  professional: "6700",
  advertising: "6800",
  contractors: "6900",
  insurance: "7000",
  utilities: "7100",
  equipment: "7200",
  taxes: "7300",
  draw: "3100",
};

type Next = () => number;
type Memo = (next: Next, day: number) => string;

const pick = <T>(next: Next, values: readonly T[]): T =>
  values[Math.floor(next() * values.length)] as T;
const alnum = (next: Next, length: number): string => {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  let out = "";
  for (let index = 0; index < length; index++) out += pick(next, [...letters]);
  return out;
};
const digits = (next: Next, length: number): string => {
  let out = "";
  for (let index = 0; index < length; index++) out += Math.floor(next() * 10);
  return out;
};
const two = (value: number): string => String(value).padStart(2, "0");
const rail = (next: Next, day: number): string =>
  pick(next, [
    "",
    "",
    "",
    "POS DEBIT ",
    "CHECKCARD ",
    `PURCHASE AUTHORIZED ON ${two(1 + (day % 12))}/${two(1 + (day % 28))} `,
    "RECURRING PAYMENT ",
  ]);
const city = (next: Next): string =>
  pick(next, [
    "SAN FRANCISCO CA",
    "OAKLAND CA",
    "NEW YORK NY",
    "AUSTIN TX",
    "SEATTLE WA",
    "BROOKLYN NY",
    "PORTLAND OR",
    "DENVER CO",
  ]);

interface Merchant {
  readonly account: string;
  /** How often per month, on average. */
  readonly perMonth: number;
  /** A bounded signed amount in cents, or a function of the random stream. */
  readonly cents: (next: Next) => number;
  readonly memo: Memo;
  /** The first month it appears (0 is the first), for vendors that start late. */
  readonly from?: number;
  /** Where else a person has booked it, with the share of lines, for ambiguous merchants. */
  readonly elsewhere?: readonly { readonly account: string; readonly share: number }[];
  /** Lines of this merchant happen on this day each month (subscriptions); otherwise random days. */
  readonly day?: number;
  /** Money in rather than out. */
  readonly inflow?: boolean;
}

const range = (low: number, high: number) => (next: Next) =>
  low + Math.floor(next() * (high - low + 1));
const fixed = (value: number) => () => value;

const MERCHANTS: readonly Merchant[] = [
  // Software and subscriptions: monthly, steady.
  {
    account: ACCOUNTS.software as string,
    perMonth: 1,
    day: 3,
    cents: fixed(400),
    memo: (n, d) => `${rail(n, d)}GITHUB, INC. SAN FRANCISCO CA`,
  },
  {
    account: ACCOUNTS.software as string,
    perMonth: 1,
    day: 5,
    cents: fixed(1500),
    memo: (n) => `FIGMA ${alnum(n, 6)} FIGMA.COM CA`,
  },
  {
    account: ACCOUNTS.software as string,
    perMonth: 1,
    day: 7,
    cents: fixed(1000),
    memo: (n) => `NOTION LABS, INC. ${alnum(n, 5)} SAN FRANCISCO CA`,
  },
  {
    account: ACCOUNTS.software as string,
    perMonth: 1,
    day: 9,
    cents: fixed(1250),
    memo: (n) => `SLACK T${alnum(n, 8)} SLACK.COM CA`,
  },
  {
    account: ACCOUNTS.software as string,
    perMonth: 1,
    day: 11,
    cents: fixed(1200),
    memo: (n) => `GOOGLE *GSUITE_RASTRATA ${alnum(n, 5)} CA`,
  },
  {
    account: ACCOUNTS.software as string,
    perMonth: 1,
    day: 13,
    cents: fixed(1600),
    memo: (n) => `ZOOM.US ${digits(n, 9)} SAN JOSE CA`,
  },
  {
    account: ACCOUNTS.software as string,
    perMonth: 1,
    day: 15,
    cents: fixed(5499),
    memo: (n) => `ADOBE *CREATIVE CLOUD ${alnum(n, 6)} ADOBE.LY CA`,
  },
  {
    account: ACCOUNTS.software as string,
    perMonth: 1,
    day: 17,
    cents: fixed(2000),
    memo: (n) => `OPENAI *CHATGPT SUBSCR ${alnum(n, 6)} SAN FRANCISCO CA`,
  },
  {
    account: ACCOUNTS.software as string,
    perMonth: 1,
    day: 19,
    cents: range(900, 1100),
    memo: (n) => `APPLE.COM/BILL ${alnum(n, 6)} ITUNES.COM CA`,
    elsewhere: [{ account: ACCOUNTS.equipment as string, share: 0.1 }],
  },
  {
    account: ACCOUNTS.software as string,
    perMonth: 1,
    day: 21,
    cents: fixed(3900),
    memo: (n) => `LINEAR ORBIT, INC. ${alnum(n, 5)} CA`,
    from: 4,
  },
  {
    account: ACCOUNTS.software as string,
    perMonth: 1,
    day: 23,
    cents: fixed(800),
    memo: (n) => `1PASSWORD ${alnum(n, 6)} TORONTO ON`,
  },
  {
    account: ACCOUNTS.software as string,
    perMonth: 1,
    day: 25,
    cents: fixed(2900),
    memo: (n) => `ZAPIER INC. ${alnum(n, 6)} SAN FRANCISCO CA`,
    from: 2,
  },
  // Hosting and infrastructure.
  {
    account: ACCOUNTS.hosting as string,
    perMonth: 1,
    day: 2,
    cents: range(4000, 9000),
    memo: (n) => `AWS EMEA AWS.AMAZON.COM ${digits(n, 6)} WA`,
  },
  {
    account: ACCOUNTS.hosting as string,
    perMonth: 1,
    day: 4,
    cents: fixed(2000),
    memo: (n) => `CLOUDFLARE ${alnum(n, 6)} SAN FRANCISCO CA`,
  },
  {
    account: ACCOUNTS.hosting as string,
    perMonth: 1,
    day: 6,
    cents: range(500, 4000),
    memo: (n) => `DIGITALOCEAN.COM ${alnum(n, 8)} NEW YORK NY`,
  },
  {
    account: ACCOUNTS.hosting as string,
    perMonth: 1,
    day: 8,
    cents: range(2000, 6000),
    memo: (n) => `VERCEL INC. ${alnum(n, 6)} COVINA CA`,
    from: 3,
  },
  {
    account: ACCOUNTS.hosting as string,
    perMonth: 1,
    day: 10,
    cents: range(300, 2500),
    memo: (n) => `GOOGLE *CLOUD ${alnum(n, 6)} CA`,
  },
  // Advertising.
  {
    account: ACCOUNTS.advertising as string,
    perMonth: 3,
    cents: range(2000, 25000),
    memo: (n) => `GOOGLE *ADS${digits(n, 10)} CC GOOGLE.COM CA`,
  },
  {
    account: ACCOUNTS.advertising as string,
    perMonth: 2,
    cents: range(3000, 18000),
    memo: (n) => `FACEBK *${alnum(n, 10)} FB.ME/ADS CA`,
  },
  {
    account: ACCOUNTS.advertising as string,
    perMonth: 0.4,
    cents: range(5000, 12000),
    memo: (n) => `LINKEDIN ADS ${digits(n, 8)} SUNNYVALE CA`,
    from: 6,
  },
  // Meals and coffee: random days, many places.
  {
    account: ACCOUNTS.meals as string,
    perMonth: 3,
    cents: range(450, 900),
    memo: (n, d) => `${rail(n, d)}BLUE BOTTLE COFFEE #${digits(n, 4)} OAKLAND CA`,
  },
  {
    account: ACCOUNTS.meals as string,
    perMonth: 3,
    cents: range(400, 1200),
    memo: (n, d) => `${rail(n, d)}STARBUCKS STORE ${digits(n, 5)} ${city(n)}`,
  },
  {
    account: ACCOUNTS.meals as string,
    perMonth: 3,
    cents: range(900, 2200),
    memo: (n, d) => `${rail(n, d)}CHIPOTLE ${digits(n, 4)} ${city(n)}`,
  },
  {
    account: ACCOUNTS.meals as string,
    perMonth: 3,
    cents: range(1500, 5500),
    memo: (n) =>
      `DOORDASH*${pick(n, ["THAI BASIL", "PIZZERIA", "SUSHI HOUSE", "TACO LOCO", "DELI 42"])} DOORDASH.COM CA`,
  },
  {
    account: ACCOUNTS.meals as string,
    perMonth: 2,
    cents: range(1200, 4500),
    memo: (n) => `UBER *EATS HELP.UBER.COM ${alnum(n, 5)} CA`,
  },
  {
    account: ACCOUNTS.meals as string,
    perMonth: 2,
    cents: range(2500, 9000),
    memo: (n, d) => `${rail(n, d)}WHOLE FOODS MKT #${digits(n, 5)} ${city(n)}`,
  },
  {
    account: ACCOUNTS.meals as string,
    perMonth: 1.5,
    cents: range(2000, 9000),
    memo: (n) =>
      `${pick(n, ["LA TAQUERIA", "NOODLE BAR", "THE CORNER BISTRO", "RAMEN HOUSE", "BURGER JOINT"])} ${digits(n, 4)} ${city(n)}`,
  },
  // Travel.
  {
    account: ACCOUNTS.travel as string,
    perMonth: 4,
    cents: range(800, 4200),
    memo: (n) => `UBER *TRIP HELP.UBER.COM ${alnum(n, 5)} CA`,
  },
  {
    account: ACCOUNTS.travel as string,
    perMonth: 1.5,
    cents: range(900, 3600),
    memo: (n) =>
      `LYFT *RIDE ${pick(n, ["MON", "TUE", "WED", "THU", "FRI"])} ${two(1 + Math.floor(n() * 12))}PM LYFT.COM CA`,
  },
  {
    account: ACCOUNTS.travel as string,
    perMonth: 0.7,
    cents: range(18000, 62000),
    memo: (n) => `UNITED ${digits(n, 13)} UNITED.COM TX`,
  },
  {
    account: ACCOUNTS.travel as string,
    perMonth: 0.5,
    cents: range(15000, 48000),
    memo: (n) => `DELTA AIR ${digits(n, 13)} ATLANTA GA`,
  },
  {
    account: ACCOUNTS.travel as string,
    perMonth: 0.6,
    cents: range(14000, 52000),
    memo: (n) =>
      `${pick(n, ["MARRIOTT", "HILTON", "HYATT"])} ${pick(n, ["AUSTIN", "CHICAGO", "BOSTON", "DENVER"])} ${digits(n, 6)}`,
  },
  {
    account: ACCOUNTS.travel as string,
    perMonth: 0.4,
    cents: range(9000, 30000),
    memo: (n) => `AIRBNB * ${alnum(n, 10)} AIRBNB.COM CA`,
  },
  // Office supplies, with Amazon and Costco as the ambiguous ones.
  {
    account: ACCOUNTS.office as string,
    perMonth: 6,
    cents: range(900, 14000),
    memo: (n) => `AMAZON MKTP US*${alnum(n, 9)} AMZN.COM/BILL WA`,
    elsewhere: [
      { account: ACCOUNTS.equipment as string, share: 0.2 },
      { account: ACCOUNTS.meals as string, share: 0.08 },
      { account: ACCOUNTS.software as string, share: 0.05 },
      { account: ACCOUNTS.travel as string, share: 0.04 },
    ],
  },
  {
    account: ACCOUNTS.office as string,
    perMonth: 1,
    cents: range(800, 6000),
    memo: (n) => `STAPLES ${digits(n, 5)} ${city(n)}`,
  },
  {
    account: ACCOUNTS.office as string,
    perMonth: 1.5,
    cents: range(3500, 21000),
    memo: (n) => `COSTCO WHSE #${digits(n, 4)} ${city(n)}`,
    elsewhere: [{ account: ACCOUNTS.meals as string, share: 0.45 }],
  },
  {
    account: ACCOUNTS.office as string,
    perMonth: 0.5,
    cents: range(600, 4000),
    memo: (n) => `USPS PO ${digits(n, 8)} ${city(n)}`,
  },
  // Equipment.
  {
    account: ACCOUNTS.equipment as string,
    perMonth: 0.4,
    cents: range(24000, 260000),
    memo: (n) => `APPLE STORE #R${digits(n, 3)} ${city(n)}`,
  },
  {
    account: ACCOUNTS.equipment as string,
    perMonth: 0.3,
    cents: range(9000, 90000),
    memo: (n) => `B&H PHOTO VIDEO ${digits(n, 8)} NEW YORK NY`,
  },
  // Bank fees and money handling.
  {
    account: ACCOUNTS.fees as string,
    perMonth: 1,
    day: 28,
    cents: fixed(1500),
    memo: () => "MONTHLY SERVICE FEE",
  },
  {
    account: ACCOUNTS.fees as string,
    perMonth: 0.5,
    cents: range(1500, 4500),
    memo: (n) => `WIRE TRANSFER FEE REF ${digits(n, 8)}`,
  },
  {
    account: ACCOUNTS.fees as string,
    perMonth: 0.3,
    cents: range(500, 2500),
    memo: (n) => `FOREIGN EXCHANGE FEE ${digits(n, 6)}`,
  },
  // Professional services, insurance, utilities, taxes.
  {
    account: ACCOUNTS.professional as string,
    perMonth: 1,
    day: 12,
    cents: range(25000, 45000),
    memo: (n) => `BENCH.CO ${alnum(n, 6)} VANCOUVER BC`,
    from: 1,
  },
  {
    account: ACCOUNTS.professional as string,
    perMonth: 0.25,
    cents: range(20000, 90000),
    memo: (n) => `LEGALZOOM.COM ${digits(n, 8)} GLENDALE CA`,
  },
  {
    account: ACCOUNTS.insurance as string,
    perMonth: 1,
    day: 14,
    cents: range(9500, 10500),
    memo: (n) => `NEXT INSURANCE ${alnum(n, 8)} PALO ALTO CA`,
  },
  {
    account: ACCOUNTS.utilities as string,
    perMonth: 1,
    day: 16,
    cents: range(9000, 11000),
    memo: (n) => `VERIZON WIRELESS PAYMENTS ${digits(n, 9)} ${city(n)}`,
  },
  {
    account: ACCOUNTS.utilities as string,
    perMonth: 1,
    day: 18,
    cents: fixed(7999),
    memo: (n) => `COMCAST CABLE COMM ${digits(n, 10)} ${city(n)}`,
  },
  {
    account: ACCOUNTS.utilities as string,
    perMonth: 1,
    day: 20,
    cents: range(5000, 9500),
    memo: (n) => `AT&T *BILL PAYMENT ${digits(n, 8)}`,
  },
  {
    account: ACCOUNTS.taxes as string,
    perMonth: 0.33,
    cents: range(30000, 80000),
    memo: (n) => `IRS USATAXPYMT ${digits(n, 10)} TAX PYMT`,
  },
  // Contractors.
  {
    account: ACCOUNTS.contractors as string,
    perMonth: 1,
    day: 1,
    cents: fixed(180000),
    memo: (n) => `ZELLE PAYMENT TO JANE ROE ${digits(n, 9)}`,
  },
  {
    account: ACCOUNTS.contractors as string,
    perMonth: 1,
    day: 1,
    cents: range(60000, 140000),
    memo: (n) => `WISE US INC ${alnum(n, 8)} TRANSFER TO ALEX DOE`,
    from: 5,
  },
  {
    account: ACCOUNTS.contractors as string,
    perMonth: 0.6,
    cents: range(20000, 90000),
    memo: (n) =>
      `PAYPAL *${pick(n, ["DESIGNSTUDIO", "COPYWRITER", "ILLUSTRATOR"])} ${digits(n, 10)} CA`,
  },
  // Owner draws.
  {
    account: ACCOUNTS.draw as string,
    perMonth: 1.2,
    cents: range(150000, 400000),
    memo: (n) => `ONLINE TRANSFER TO PERSONAL CHK ...${digits(n, 4)} ${digits(n, 6)}`,
  },
  // Money in.
  {
    account: ACCOUNTS.revenue as string,
    perMonth: 7,
    inflow: true,
    cents: range(9000, 380000),
    memo: (n) => `STRIPE TRANSFER ST-${alnum(n, 8)}`,
  },
  {
    account: ACCOUNTS.revenue as string,
    perMonth: 1.5,
    inflow: true,
    cents: range(80000, 650000),
    memo: (n) =>
      `ACH CREDIT ${pick(n, ["ACME CORP", "GLOBEX LLC", "INITECH INC", "UMBRELLA CO"])} INV ${digits(n, 4)}`,
  },
  {
    account: ACCOUNTS.revenue as string,
    perMonth: 0.6,
    inflow: true,
    cents: range(5000, 120000),
    memo: (n) => `PAYPAL TRANSFER ${alnum(n, 12)}`,
  },
  {
    account: ACCOUNTS.interest as string,
    perMonth: 1,
    day: 30,
    inflow: true,
    cents: range(300, 4200),
    memo: () => "INTEREST PAYMENT",
  },
  // One-off vendors the model cannot know: each appears once and never again.
  ...[
    "BRIGHTON FLORIST",
    "HARDWARE AND SUPPLY CO",
    "COWORKING DAY PASS",
    "PRINTWORKS SHOP",
    "CONFERENCE REG 2025",
    "NOTARY ON THE GO",
  ].map(
    (name): Merchant => ({
      account: name.startsWith("CONF")
        ? (ACCOUNTS.professional as string)
        : (ACCOUNTS.office as string),
      perMonth: 0.06,
      cents: range(1500, 24000),
      memo: (n) => `${name} ${digits(n, 5)} ${city(n)}`,
    }),
  ),
];

const MONTHS = 18;
const START_YEAR = 2025;
const WRONG_SHARE = 0.02;
const EXPENSE_ACCOUNTS = [
  ACCOUNTS.software,
  ACCOUNTS.hosting,
  ACCOUNTS.meals,
  ACCOUNTS.travel,
  ACCOUNTS.office,
  ACCOUNTS.professional,
  ACCOUNTS.advertising,
  ACCOUNTS.utilities,
] as readonly string[];

const daysIn = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

export interface FixtureOptions {
  readonly seed?: number;
  /** Share of lines a person booked to the wrong account, between 0 and 1. */
  readonly wrongShare?: number;
}

/** The history, oldest first. */
export function classifierHistory(options: FixtureOptions = {}): TrainingExample[] {
  const next = random(options.seed ?? 20260101);
  const wrongShare = options.wrongShare ?? WRONG_SHARE;
  const out: TrainingExample[] = [];
  let sequence = 0;
  for (let month = 0; month < MONTHS; month++) {
    const year = START_YEAR + Math.floor(month / 12);
    const calendarMonth = (month % 12) + 1;
    const length = daysIn(year, calendarMonth);
    for (const merchant of MERCHANTS) {
      if (merchant.from !== undefined && month < merchant.from) continue;
      // A merchant with a fixed day occurs once a month; otherwise lines fall on random days, with
      // the monthly rate turned into a whole count by chance (0.4 a month is two months in five).
      let count = merchant.day !== undefined ? 1 : Math.floor(merchant.perMonth);
      if (merchant.day === undefined && next() < merchant.perMonth - Math.floor(merchant.perMonth))
        count++;
      if (merchant.day !== undefined && merchant.perMonth < 1 && next() > merchant.perMonth)
        count = 0;
      for (let index = 0; index < count; index++) {
        const day =
          merchant.day !== undefined
            ? Math.min(merchant.day, length)
            : 1 + Math.floor(next() * length);
        const memo = merchant.memo(next, day);
        let account = merchant.account;
        let roll = next();
        for (const other of merchant.elsewhere ?? []) {
          if (roll < other.share) {
            account = other.account;
            break;
          }
          roll -= other.share;
        }
        // A person's slip: a line booked to some other expense account.
        if (!merchant.inflow && account !== ACCOUNTS.draw && next() < wrongShare)
          account = pick(
            next,
            EXPENSE_ACCOUNTS.filter((candidate) => candidate !== account),
          );
        sequence++;
        out.push({
          key: `fixture:${String(sequence).padStart(5, "0")}`,
          accountId: account,
          text: memo,
          direction: merchant.inflow ? "in" : "out",
          on: `${year}-${two(calendarMonth)}-${two(day)}`,
        });
      }
    }
  }
  return out.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : a.key < b.key ? -1 : 1));
}
