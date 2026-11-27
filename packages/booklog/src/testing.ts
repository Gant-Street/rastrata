/** What a test, a simulation or a load script needs to stand in for a bucket and a tail: the
 * in-memory object store and log tier with their seeded faults, the virtual clock that makes a
 * schedule reproducible, simulated process clocks, and the generator behind all of them. */
export { VirtualClock } from "./clock.ts";
export {
  FAULT_KINDS,
  MemoryObjectStore,
  STORE_OPS,
  type MemoryStoreOptions,
  type ScriptedFault,
  type StoreOp,
  type StoreStats,
} from "./memory.ts";
export { SimPodClock } from "./podclock.ts";
export { Rng, hashSeed } from "./rng.ts";
export {
  MemoryLogTier,
  TIER_OPS,
  type MemoryTierOptions,
  type TierOp,
  type TierRecord,
  type TierScriptedFault,
} from "./tier-memory.ts";
export {
  Wire,
  type FaultKind,
  type FaultRates,
  type LatencyModel,
  type WireOptions,
} from "./wire.ts";
