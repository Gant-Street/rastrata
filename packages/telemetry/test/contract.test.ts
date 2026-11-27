import { recordTelemetry } from "../src/testing.ts";
import { defineBackendContract } from "./contract.ts";
import { sdkRecorder } from "./support/sdk-recorder.ts";

defineBackendContract("in-memory backend", () => {
  const recorder = recordTelemetry();
  return Object.assign(recorder, {
    finished: async () => recorder.spans,
    settle: async () => {},
  });
});

// The exporting backend, with the real SDK and exporters that only keep what they are given: it must
// do everything the fast backend does, or a lane's tests would pass against something else.
defineBackendContract("exporting backend", () => sdkRecorder());
