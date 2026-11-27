import type { PreparedLine, RuleEntry } from "./engine.ts";

/** How the rules in order behave over a set of lines: for each rule, how many lines it matches, how
 * many it decides (it is the first enabled rule to match) and how many it matches but an earlier
 * rule decides instead. This is the answer to "does this rule earn its place?": a rule that matches
 * nothing is dead, and one that matches lines but never decides any is hidden behind an earlier rule.
 *
 * A disabled rule is measured too (what it *would* match), so a person can see what switching it
 * on would do, but it never decides and is never "shadowed". */

export interface RuleUsage {
  /** Lines the rule's scope and conditions match, whatever else matches them. */
  readonly matched: number;
  /** Lines this rule decides: it is the first enabled rule to match. */
  readonly decided: number;
  /** Lines it matches that an earlier enabled rule decides instead. */
  readonly shadowed: number;
  /** The newest posting date among its matches, or null. */
  readonly lastMatchedOn: string | null;
}

export interface UsageReport {
  readonly perRule: ReadonlyMap<string, RuleUsage>;
  /** Lines at least one enabled rule decides. */
  readonly decidedLines: number;
  readonly considered: number;
}

export function measureUsage(
  entries: readonly RuleEntry[],
  lines: readonly PreparedLine[],
): UsageReport {
  const matched = new Map<string, number>();
  const decided = new Map<string, number>();
  const shadowed = new Map<string, number>();
  const latest = new Map<string, string>();
  let decidedLines = 0;
  for (const line of lines) {
    let decidedHere = false;
    for (const entry of entries) {
      if (!entry.matches(line)) continue;
      matched.set(entry.id, (matched.get(entry.id) ?? 0) + 1);
      const on = line.line.postedOn;
      const seen = latest.get(entry.id);
      if (seen === undefined || on > seen) latest.set(entry.id, on);
      if (!entry.definition.enabled) continue;
      if (decidedHere) shadowed.set(entry.id, (shadowed.get(entry.id) ?? 0) + 1);
      else {
        decidedHere = true;
        decided.set(entry.id, (decided.get(entry.id) ?? 0) + 1);
      }
    }
    if (decidedHere) decidedLines++;
  }
  const perRule = new Map<string, RuleUsage>();
  for (const entry of entries)
    perRule.set(entry.id, {
      matched: matched.get(entry.id) ?? 0,
      decided: decided.get(entry.id) ?? 0,
      shadowed: shadowed.get(entry.id) ?? 0,
      lastMatchedOn: latest.get(entry.id) ?? null,
    });
  return { perRule, decidedLines, considered: lines.length };
}
