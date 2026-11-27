/** The test files that failed, read from the runner's output: Bun prints a file's path on a line of its own, ending in a
 * colon, before that file's tests, and a failed test as a line that starts with "(fail)". */
export function failedFiles(output: string): string[] {
  const files = new Set<string>();
  let current: string | undefined;
  for (const line of output.split("\n")) {
    const header = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    if (line.startsWith("(fail)") && current) files.add(current);
  }
  return [...files];
}
