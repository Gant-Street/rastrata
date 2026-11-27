import type { ChangeListInput, ChangeReviewInput } from "../../client-contracts.gen.ts";
import type { SliceHandlers } from "../types.ts";
import { listChanges } from "./list.ts";
import { reviewChanges } from "./review.ts";

export const changesHandlers: SliceHandlers = {
  "changes.list": (input, context) => listChanges(context, input as ChangeListInput),
  "changes.review": (input, context) => reviewChanges(context, input as ChangeReviewInput),
};
