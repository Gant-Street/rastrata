import {
  commandId,
  instant,
  localDate,
  sealCommand,
  semanticVersion,
  type BookCommand,
} from "../src/index.ts";
import { IDS } from "./fixtures.ts";

export function activationCommand(id = "command-activate", expectedBookRevision = 0n): BookCommand {
  return sealCommand({
    id: commandId(id),
    type: "activateBook",
    protocolVersion: semanticVersion("1.0.0"),
    bookId: IDS.book,
    expectedBookRevision,
    issuedAt: instant("2026-01-01T00:00:00Z"),
    completedAt: instant("2026-01-01T00:00:01Z"),
    committedAt: instant("2026-01-01T00:00:02Z"),
    actorId: IDS.actor,
    mode: "newZeroBalance",
    boundaryId: IDS.boundary,
    firstAccountingDate: localDate("2026-01-01"),
  });
}
