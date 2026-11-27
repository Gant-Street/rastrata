import type { BackupSettings } from "../../client-contracts.gen.ts";
import { exportBook } from "../../safety/export-job.ts";
import { runJobOperation, safetyRuntime } from "../../safety/jobs.ts";
import {
  createBackup,
  drillBackup,
  exportHost,
  listBackups,
  listExports,
  readStatus,
  safetyHost,
  verifyBackup,
} from "../../safety/operations.ts";
import { safetyStore } from "../../safety/store.ts";
import type { SliceHandlers } from "../types.ts";

const target = (input: Record<string, unknown>): string | undefined =>
  typeof input.backupId === "string" ? input.backupId : undefined;

export const safetyHandlers: SliceHandlers = {
  "backup.status": (_input, { service }) => readStatus(service),
  "backup.list": (_input, { service }) => listBackups(service),
  "export.list": (_input, { service }) => listExports(service),
  "backup.create": (input, { service, operationId }) => {
    safetyHost(service);
    return runJobOperation(
      service,
      { operationId, operation: "backup.create", input, kind: "backup" },
      (progress) => createBackup(service, "manual", progress),
    );
  },
  "backup.verify": (input, { service, operationId }) => {
    safetyHost(service);
    return runJobOperation(
      service,
      { operationId, operation: "backup.verify", input, kind: "verify" },
      (progress) => verifyBackup(service, target(input), progress),
    );
  },
  "backup.drill": (input, { service, operationId }) => {
    safetyHost(service);
    return runJobOperation(
      service,
      { operationId, operation: "backup.drill", input, kind: "drill" },
      (progress) => drillBackup(service, target(input), progress),
    );
  },
  "export.create": (input, { service, operationId }) => {
    exportHost(service);
    return runJobOperation(
      service,
      { operationId, operation: "export.create", input, kind: "export" },
      (progress) => exportBook(service, progress),
    );
  },
  "backup.configure": (input, { service, operationId }) => {
    safetyHost(service);
    // Create the tables first: the retained write below runs inside a transaction of its own.
    const store = safetyStore(service);
    return service.retainRequest(operationId, "backup.configure", input, () =>
      store.saveSettings(input as unknown as BackupSettings, safetyRuntime(service).now()),
    );
  },
};
