/** The rules lane's pure core: text handling, the rules engine, exact-cents splits, narration
 * templates, rule suggestion, the naive Bayes classifier and its evaluation harness. Everything here
 * is portable (no bun:, node: or I/O) and deterministic. Behaviour that touches the book lives in
 * slices/rules/. */
export * from "./allocation.ts";
export * from "./classifier.ts";
export * from "./engine.ts";
export * from "./evaluate.ts";
export * from "./history.ts";
export * from "./narration.ts";
export * from "./normalize.ts";
export * from "./suggest.ts";
export * from "./text.ts";
export * from "./types.ts";
export * from "./usage.ts";
export * from "./validate.ts";
