import { describe, expect, test } from "bun:test";
import {
  entryHref,
  outstandingView,
  reportBlob,
  reportFileName,
  type ReconcileReport,
} from "../../src/routes/reconcile/report";

const report = (over: Partial<ReconcileReport["outstanding"]> = {}): ReconcileReport => ({
  id: "r1",
  status: "completed",
  account: { id: "1000", code: "1000", name: "Checking", role: "asset", normalSide: "debit" },
  currency: "USD",
  statementDate: "2026-01-31",
  statementBalance: "1209.90",
  openingBalance: "0.00",
  previous: null,
  completedAt: "2026-02-02T10:00:00.000Z",
  recordHash: "0".repeat(64),
  previousHash: null,
  bookRevision: "19",
  void: null,
  cleared: { count: 0, total: "0.00", lines: [] },
  outstanding: {
    count: 1,
    total: "-19.90",
    lines: [
      {
        postingId: "p4",
        journalId: "j 4/x",
        date: "2026-01-20",
        narration: "Software subscription",
        amount: "-19.90",
      },
    ],
    ...over,
  },
  bookBalance: "1190.00",
  difference: "0.00",
});

describe("what the page shows of the report", () => {
  test("the figures are the report's own, and a transaction links to its entry at the revision the report was read at", () => {
    const view = outstandingView(report());
    expect(view).toEqual({
      statementDate: "2026-01-31",
      statementBalance: "1209.90",
      bookBalance: "1190.00",
      total: "-19.90",
      lines: [
        {
          id: "p4",
          date: "2026-01-20",
          description: "Software subscription",
          amount: "-19.90",
          href: "/journal/j%204%2Fx?revision=19",
        },
      ],
    });
    expect(entryHref("a", "7")).toBe("/journal/a?revision=7");
  });

  test("a statement with nothing off it has no lines, and still says the books' balance", () => {
    const view = outstandingView(report({ count: 0, total: "0.00", lines: [] }));
    expect(view.lines).toEqual([]);
    expect(view.total).toBe("0.00");
    expect(view.bookBalance).toBe("1190.00");
  });
});

describe("the file that is saved", () => {
  test("keeps the service's name when it is plain and makes one plain when it is not", () => {
    expect(reportFileName("reconciliation-1000-2026-01-31.csv")).toBe(
      "reconciliation-1000-2026-01-31.csv",
    );
    expect(reportFileName("../../etc/passwd.csv")).toBe("etc-passwd.csv");
    expect(reportFileName("a b‮\n.csv")).toBe("a-b--.csv");
    expect(reportFileName(".csv")).toBe("reconciliation-report.csv");
    expect(reportFileName("report.html")).toBe("reconciliation-report.csv");
    expect(reportFileName("")).toBe("reconciliation-report.csv");
    expect(reportFileName(`${"x".repeat(300)}.csv`).length).toBeLessThanOrEqual(100);
  });

  test("starts with a byte order mark and holds the service's text exactly", async () => {
    const blob = reportBlob({
      mediaType: "text/csv; charset=utf-8",
      content: "Report,Reconciliation\r\n",
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe("Report,Reconciliation\r\n");
    expect(blob.type).toBe("text/csv; charset=utf-8");
  });
});
