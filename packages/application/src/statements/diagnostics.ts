import type { ParseDiagnostic } from "../ingest-types.ts";

/** Collects what a parser noticed, with exact counts and a bounded list.
 *
 * Every problem is a diagnostic with a row number where there is one. A file with ten thousand
 * hostile cells must not produce ten thousand messages, so each kind of problem keeps its first few
 * and then one summary line; the counts stay exact, because "no errors" decides whether a file can
 * be committed. */

export interface DiagnosticCounts {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
}

const PER_KIND = 12;
const TOTAL_CAP = 400;

export class Diagnostics {
  private readonly kept: ParseDiagnostic[] = [];
  private readonly perKind = new Map<string, number>();
  private readonly firstOfKind = new Map<string, ParseDiagnostic>();
  private readonly errorKindCounts = new Map<string, number>();
  private errors = 0;
  private warnings = 0;
  private infos = 0;

  /** Record one problem. `kind` groups repeats of the same problem so they can be summarised. */
  add(severity: ParseDiagnostic["severity"], kind: string, message: string, row?: number): void {
    if (severity === "error") {
      this.errors++;
      this.errorKindCounts.set(kind, (this.errorKindCounts.get(kind) ?? 0) + 1);
    } else if (severity === "warning") this.warnings++;
    else this.infos++;
    const seen = (this.perKind.get(kind) ?? 0) + 1;
    this.perKind.set(kind, seen);
    const diagnostic: ParseDiagnostic =
      row === undefined ? { severity, message } : { severity, row, message };
    if (!this.firstOfKind.has(kind)) this.firstOfKind.set(kind, diagnostic);
    if (seen <= PER_KIND && this.kept.length < TOTAL_CAP) this.kept.push(diagnostic);
  }

  error(kind: string, message: string, row?: number): void {
    this.add("error", kind, message, row);
  }
  warning(kind: string, message: string, row?: number): void {
    this.add("warning", kind, message, row);
  }
  info(kind: string, message: string, row?: number): void {
    this.add("info", kind, message, row);
  }

  get counts(): DiagnosticCounts {
    return { errors: this.errors, warnings: this.warnings, infos: this.infos };
  }

  /** How many problems of one kind were recorded, kept or not. */
  count(kind: string): number {
    return this.perKind.get(kind) ?? 0;
  }

  /** The kinds of error recorded, with how many of each. */
  errorKinds(): ReadonlyMap<string, number> {
    return this.errorKindCounts;
  }

  /** The bounded list, errors first and then in order of appearance, with one line for each kind
   * that was cut short. */
  list(): ParseDiagnostic[] {
    const summaries: ParseDiagnostic[] = [];
    for (const [kind, total] of this.perKind) {
      if (total <= PER_KIND) continue;
      const sample = this.firstOfKind.get(kind) as ParseDiagnostic;
      summaries.push({
        severity: sample.severity,
        message: `${total - PER_KIND} more like this: ${sample.message}`,
      });
    }
    const all = [...this.kept, ...summaries];
    const rank = { error: 0, warning: 1, info: 2 } as const;
    return all
      .map((diagnostic, index) => ({ diagnostic, index }))
      .sort(
        (a, b) => rank[a.diagnostic.severity] - rank[b.diagnostic.severity] || a.index - b.index,
      )
      .map(({ diagnostic }) => diagnostic);
  }
}
