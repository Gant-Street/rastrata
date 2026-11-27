import { XeroScreen } from "@rastrata/ui";
import { BrowserApplicationClient } from "../../application-client";
import { createXeroController } from "./xero-controller";

/** Import from Xero: read its exports and keep what the comparison needs. The route is thin: the
 * controller holds the state and the writes, and the screen renders what it is given. */
export function XeroPage() {
  const controller = createXeroController(new BrowserApplicationClient(window.localStorage));
  return <XeroScreen {...controller.props()} />;
}
