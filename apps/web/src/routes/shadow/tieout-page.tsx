import { TieoutScreen } from "@rastrata/ui";
import { BrowserApplicationClient } from "../../application-client";
import { createTieoutController } from "./tieout-controller";

/** The comparison with Xero, and recording what it found in the gap log. */
export function TieoutPage() {
  const controller = createTieoutController(new BrowserApplicationClient(window.localStorage));
  return <TieoutScreen {...controller.props()} />;
}
