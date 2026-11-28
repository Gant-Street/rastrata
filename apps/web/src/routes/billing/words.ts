/** The words of the Billing page: plain, calm, and the same ones every time. What the page says about how a workspace stands is in billing-controller.ts, where the banner uses it too. */
export const billingWords = {
  title: "Billing",
  loading: "Reading your billing…",
  failed: "Billing could not be read",
  retry: "Try again",
  notHere: "Billing is not here",
  notHereBody: "This page is for a workspace on the service with accounts.",
  subscribeTitle: "Subscribe",
  subscribeBody:
    "One flat plan covers every business you own. You pay on Stripe's own page; Rastrata never sees your card.",
  subscribe: (price: string) => `Subscribe, ${price}`,
  opening: "Opening Stripe…",
  manageTitle: "Your subscription",
  manageBody:
    "Change the card, switch between monthly and yearly, see your invoices, or cancel, in Stripe's customer portal.",
  manage: "Manage subscription",
  onlyOwner: "The billing owner of this workspace manages billing.",
};
