// One line per lane. Lanes edit their own folder, not this registry.
import { calendarAdvisor } from "./calendar/advisor.ts";
import { reconcileAdvisor } from "./reconcile/advisor.ts";
import type { Advisor, AdvisorContext, PlanWarning } from "./types.ts";

/** Consulted in this order each time a plan is prepared. */
export const advisors: readonly (readonly [string, Advisor])[] = [
  ["calendar", calendarAdvisor],
  ["reconcile", reconcileAdvisor],
];

/** The most warnings a plan carries and the longest one, matching the contract. */
const MAX_WARNINGS = 50;
const MAX_MESSAGE = 500;

/** Every warning the lanes have for a plan. An advisor that fails does not break the preview: the
 * failure is itself a warning, so a check that did not run is never mistaken for a check that
 * passed. */
export async function adviseOnPlan(
  context: AdvisorContext,
  registered: readonly (readonly [string, Advisor])[] = advisors,
): Promise<PlanWarning[]> {
  const warnings: PlanWarning[] = [];
  for (const [lane, advise] of registered) {
    try {
      warnings.push(...(await advise(context)));
    } catch {
      warnings.push({
        code: "advisor_unavailable",
        message: `The ${lane} checks could not be run for this change. Review it without them.`,
      });
    }
  }
  return warnings.slice(0, MAX_WARNINGS).map((warning) => ({
    code: warning.code.slice(0, 80),
    message:
      warning.message.length > MAX_MESSAGE
        ? `${warning.message.slice(0, MAX_MESSAGE - 1)}…`
        : warning.message,
  }));
}
