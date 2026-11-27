import type { PeriodList } from "@rastrata/application/client-contracts";
import { YearEndFlow } from "@rastrata/ui";
import { createMemo } from "solid-js";
import type { BrowserApplicationClient } from "../../application-client";
import { toYears } from "./convert";
import { createYearEndController } from "./year-end";

/** The guided year-end for one fiscal year, bound to the service. The controller lives exactly as
 * long as the flow is open, so leaving it drops whatever was read for the checklist. */
export function YearEndSection(props: {
  client: BrowserApplicationClient;
  list: PeriodList;
  fiscalYear: number;
  /** The year on show changed because a resumed request was for another year. */
  onYear: (year: number) => void;
  /** Read the periods again, after a commit. */
  onChanged: () => Promise<void>;
  onBack: () => void;
}) {
  const controller = createYearEndController({
    client: props.client,
    fiscalYear: () => props.fiscalYear,
    list: () => props.list,
    onChanged: props.onChanged,
    onYear: props.onYear,
  });
  const year = createMemo(() =>
    toYears(props.list).find((item) => item.fiscalYear === props.fiscalYear),
  );
  return (
    <YearEndFlow
      fiscalYear={props.fiscalYear}
      startsOn={year()?.startsOn ?? ""}
      endsOn={year()?.endsOn ?? ""}
      stage={controller.stage()}
      checklist={controller.checklist()}
      statements={controller.statements()}
      reason={controller.reason()}
      onReason={controller.setReason}
      reasonError={controller.reasonError()}
      attempt={controller.attempt()}
      error={controller.error()}
      plan={controller.plan()}
      planCurrent={controller.planCurrent()}
      receipt={controller.receipt()}
      uncertain={controller.uncertain()}
      busy={controller.busy()}
      periodsToClose={controller.periodsToClose()}
      onPrepare={() => void controller.prepare()}
      onCommit={() => void controller.commit()}
      onResume={() => void controller.resume()}
      onBack={props.onBack}
      onReviewAgain={() => void controller.reviewAgain()}
    />
  );
}
