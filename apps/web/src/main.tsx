import { RouterProvider } from "@tanstack/solid-router";
import { ToastProvider, UiProvider } from "@rastrata/ui";
import { registerFonts } from "@rastrata/ui/fonts";
import { fontsFor } from "@rastrata/ui/fonts-ready";
import { render } from "solid-js/web";
import { BrowserApplicationClient } from "./application-client";
import { readBookSettings } from "./book-settings";
import { bootAccounts, currentAccount } from "./boot";
import { noteDrawn, reportLoad } from "./load-timing";
import { openWorkspace, setupPending } from "./new-book";
import { OPENING_WAIT_MS, openedText, openingRead } from "./opening";
import { preloadScreensWhenIdle } from "./preload";
import { router } from "./router";
import { serviceAsksForRum } from "./rum-hook";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
// The faces of the scripts that are not Latin are files the browser fetches when a character needs one (packages/ui/tooling/fonts.ts).
registerFonts();
// On a service with accounts the page needs to know whose workspace is open before it asks for anything; if there is none, it is on its way to the page
// that lets the person choose one, and draws nothing here (boot.ts).
const boot = await bootAccounts({
  readBook: () => new BrowserApplicationClient(window.localStorage).read("book.get", {}),
});
if (!boot.redirecting) {
  // The page is drawn once and whole: the book's name, who is signed in and what the workspace owes are read before the first draw (opening.ts), so nothing
  // arrives in the header or the footer after them. A service that is slow to answer does not hold the page back for long.
  // A workspace this browser last saw with its books still to be set up draws the setup at once (new-book.ts): nothing of the book is in that page's header.
  await openingRead(OPENING_WAIT_MS, setupPending(openWorkspace()) ? ["book"] : []);
  // A business named in a script that is not Latin has its typeface file before the header is drawn, so that the name is not drawn in one face and then another (packages/ui/src/fonts-ready.ts).
  await fontsFor(openedText());
  // What the owner chose in Settings (how dates read, account numbers in lists, what Accept does) applies from
  // the first screen. It is read once here and never holds up the first paint: until the answer arrives the
  // defaults apply, and a screen that shows dates follows the choice when it does.
  void readBookSettings();
  // The toasts (a polite live region, with Undo) are mounted once, here, so a screen can say that something
  // happened from anywhere: `useToast()` throws while a screen is made when there is no provider.
  render(
    () => (
      <UiProvider locale="en-US">
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </UiProvider>
    ),
    root,
  );
  // How long the page took to open is reported by a page that has a person signed in, once, with numbers only (load-timing.ts).
  if (currentAccount() !== null) {
    noteDrawn();
    reportLoad();
  }
  // Every other screen is a file of its own (routes/screen.ts): they are fetched one at a time when the browser is idle after the first draw, the places first, so that a click finds its screen here.
  void preloadScreensWhenIdle();
  // How the pages feel to the person using them is measured only where the service asks for it (a
  // hosted service says so in the Server-Timing header of this document). Elsewhere, the local product
  // and every self-hosted service, the measurement is never loaded.
  if (serviceAsksForRum()) void import("./rum").then((rum) => rum.startRum());
}
