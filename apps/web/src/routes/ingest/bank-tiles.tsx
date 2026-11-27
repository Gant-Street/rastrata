import { BankTileBand } from "@rastrata/ui";
import { onMount } from "solid-js";
import { bankingSummary, bankTileLinks } from "./summary";

/** The bank tiles, wired: one cell for each bank, card and Stripe account, drawn from the banking
 * summary the whole application shares (Home and the Banking pages never read these operations
 * themselves). It shows what is already known at once and reads again in the background, so the
 * figures are current without the page waiting for them. */
export function BankTiles(props: { headingLevel?: 2 | 3 | 4 }) {
  const summary = bankingSummary();
  onMount(() => void summary.reload(2_000));
  return (
    <BankTileBand
      tiles={summary.tiles()}
      state={summary.state()}
      stale={summary.stale()}
      links={bankTileLinks}
      onRetry={() => void summary.reload()}
      {...(props.headingLevel ? { headingLevel: props.headingLevel } : {})}
    />
  );
}
