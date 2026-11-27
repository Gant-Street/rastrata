import type {
  InboxAcceptInput,
  InboxBalanceChecksInput,
  InboxCategorizeInput,
  InboxConfigureSourceInput,
  InboxExcludeInput,
  InboxListInput,
  InboxPostInput,
  InboxRestoreInput,
  InboxTextsInput,
} from "../../client-contracts.gen.ts";
import { describePrincipal } from "../../agent/principal.ts";
import type { SliceHandlers } from "../types.ts";
import { acceptItems, categorizeItems, configureSource, excludeItems } from "./actions.ts";
import { postItems, refreshInbox, restoreItems } from "./posting.ts";
import {
  getInboxItem,
  inboxBalanceChecks,
  inboxSources,
  inboxSummary,
  inboxTexts,
  listInbox,
} from "./queries.ts";

export const ingestHandlers: SliceHandlers = {
  "inbox.list": (input, { service }) => listInbox(service, input as InboxListInput),
  "inbox.texts": (input, { service }) => inboxTexts(service, input as InboxTextsInput),
  "inbox.get": (input, { service }) => getInboxItem(service, input.itemId as string),
  "inbox.summary": (_input, { service }) => inboxSummary(service),
  "inbox.sources": (_input, { service }) => inboxSources(service),
  "inbox.balanceChecks": (input, { service }) =>
    inboxBalanceChecks(service, input as InboxBalanceChecksInput),
  "inbox.categorize": (input, { service, access, operationId }) =>
    categorizeItems(
      service,
      input as InboxCategorizeInput,
      operationId,
      describePrincipal(access.principal),
    ),
  "inbox.accept": (input, { service, access, operationId }) =>
    acceptItems(
      service,
      input as InboxAcceptInput,
      operationId,
      describePrincipal(access.principal),
    ),
  "inbox.exclude": (input, { service, access, operationId }) =>
    excludeItems(
      service,
      input as InboxExcludeInput,
      operationId,
      describePrincipal(access.principal),
    ),
  "inbox.restore": (input, { service, access, operationId }) =>
    restoreItems(
      service,
      input as InboxRestoreInput,
      operationId,
      describePrincipal(access.principal),
    ),
  "inbox.post": (input, { service, access, operationId }) =>
    postItems(service, input as InboxPostInput, operationId, describePrincipal(access.principal)),
  "inbox.configureSource": (input, { service, access, operationId }) =>
    configureSource(
      service,
      input as InboxConfigureSourceInput,
      operationId,
      describePrincipal(access.principal),
    ),
  "inbox.refresh": (_input, { service, operationId }) => refreshInbox(service, operationId),
};
