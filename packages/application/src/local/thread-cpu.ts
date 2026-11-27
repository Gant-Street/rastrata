/** CPU seconds the calling thread has used, or 0 where the runtime cannot say. A worker reports the
 * difference over its task, so a backup or a verification can be priced by the CPU it spent itself
 * and not by what the whole process did meanwhile. Imports nothing, because a worker must start
 * quickly. */
export function threadCpuSeconds(): number {
  const read = (process as { threadCpuUsage?: () => { user: number; system: number } })
    .threadCpuUsage;
  if (typeof read !== "function") return 0;
  const usage = read.call(process);
  return (usage.user + usage.system) / 1e6;
}
