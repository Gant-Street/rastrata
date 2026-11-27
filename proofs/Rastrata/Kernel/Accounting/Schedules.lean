/-
Allocation schedules (`packages/kernel/src/accounting.ts` lines 1543 to 1755): the model and its
laws, in the modules of `Accounting/Schedules/`.

- `Model`: the types (`AllocationScheduleRequest`, `AllocationRecognitionRequest`,
  `AllocationScheduleRevisionRequest`, `AllocationAccountingState`), `monthsBetween`, `addMonths`,
  `scheduleStepMonths`, `createAllocationSchedule`, `recognizeScheduledAllocation` and
  `reviseAllocationSchedule`, each with the checks of the TypeScript in its order and the
  diagnostics in full. `planAllocationPostings`, `usesCumulativeAllocation` and
  `allocationPlanIsValid` are modelled in `Accounting/Core/Model.lean` and used from there.
- `Calendar`: `monthsBetween` and `addMonths` are the calendar arithmetic they name.
- `Basics`, `Generate`: the toolbox, and what the exact amounts and dates of a schedule satisfy.
- `Create`: the laws of `createAllocationSchedule`.
- `Recognize`: the laws of `recognizeScheduledAllocation`.
- `Revise`: the laws of `reviseAllocationSchedule`.
-/
import Rastrata.Kernel.Accounting.Schedules.Model
import Rastrata.Kernel.Accounting.Schedules.Calendar
import Rastrata.Kernel.Accounting.Schedules.Basics
import Rastrata.Kernel.Accounting.Schedules.Generate
import Rastrata.Kernel.Accounting.Schedules.Create
import Rastrata.Kernel.Accounting.Schedules.Recognize
import Rastrata.Kernel.Accounting.Schedules.Revise
