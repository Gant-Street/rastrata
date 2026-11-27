/** The parts of the rules lane that are plain functions and plain words, with no components and no
 * Solid: the draft the editor holds and the small steps that change it, the words, and the reading
 * aids. They are exported on their own (`@rastrata/ui/rules-logic`) so the web app's mapping code
 * between a draft and a rule can be tested without a browser, and so a program that only needs the
 * words does not load a component library. */
export * from "./draft";
export { basisText, percentOfCounts, ratioText } from "./format";
export type * from "./types";
export { words } from "./words";
