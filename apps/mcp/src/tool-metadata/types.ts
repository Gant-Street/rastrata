export interface ToolMetadata {
  /** The MCP tool name, rastrata_<verb>_<noun>. Unique across all lanes. */
  readonly name: string;
  readonly title: string;
  /** Written for a model: what it does, what it cannot do, what to do first. */
  readonly description: string;
  /** True only for writes that cannot be undone by a linked correction. */
  readonly destructive?: boolean;
}

/** An operation that deliberately has no MCP tool. Every operation needs an entry, so leaving one
 * out stays an error; this says the omission is on purpose. Use it only when a model must never
 * be able to call the operation, for example because its result is a secret that would land in the
 * conversation. The operation stays available to the CLI and the web app. */
export interface HiddenOperation {
  readonly hidden: true;
  /** Why no model should have this tool. Shown in tests and reviews, never to a model. */
  readonly reason: string;
}

export type OperationMetadata = ToolMetadata | HiddenOperation;

export const isHidden = (entry: OperationMetadata): entry is HiddenOperation => "hidden" in entry;
