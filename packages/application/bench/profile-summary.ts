// Summarise a Bun CPU profile: where the time goes, by function, self and inclusive.
//   bun --cpu-prof --cpu-prof-dir=/tmp/prof bench/scale.ts
//   bun bench/profile-summary.ts /tmp/prof/CPU.*.cpuprofile [top=25] [root]
// With a root (a function name, such as compileCoreReports) only the samples taken inside a call of it are counted.
import { readFileSync } from "node:fs";

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
interface Profile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

const file = process.argv[2];
if (!file) throw new Error("usage: bun bench/profile-summary.ts <file.cpuprofile> [top=25]");
const top = Number(process.argv[3] ?? "25");
const root = process.argv[4];
const profile = JSON.parse(readFileSync(file, "utf8")) as Profile;

const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map<number, number>();
for (const node of profile.nodes)
  for (const child of node.children ?? []) parent.set(child, node.id);

const insideRoot = (id: number): boolean => {
  if (root === undefined) return true;
  for (let cursor: number | undefined = id; cursor !== undefined; cursor = parent.get(cursor))
    if ((byId.get(cursor) as ProfileNode).callFrame.functionName === root) return true;
  return false;
};

const self = new Map<number, number>();
let total = 0;
profile.samples.forEach((id, index) => {
  if (!insideRoot(id)) return;
  const delta = (profile.timeDeltas[index] ?? 0) / 1000;
  self.set(id, (self.get(id) ?? 0) + delta);
  total += delta;
});

const label = (id: number) => {
  const frame = (byId.get(id) as ProfileNode).callFrame;
  const where = frame.url.replace(/^file:\/\//, "").replace(/^.*\/packages\//, "packages/");
  return `${frame.functionName || "(anonymous)"} ${where}:${frame.lineNumber + 1}`;
};

const selfByLabel = new Map<string, number>();
const inclusiveByLabel = new Map<string, number>();
for (const [id, ms] of self) {
  const name = label(id);
  selfByLabel.set(name, (selfByLabel.get(name) ?? 0) + ms);
  const seen = new Set<string>();
  for (let cursor: number | undefined = id; cursor !== undefined; cursor = parent.get(cursor)) {
    const frame = label(cursor);
    if (seen.has(frame)) continue;
    seen.add(frame);
    inclusiveByLabel.set(frame, (inclusiveByLabel.get(frame) ?? 0) + ms);
  }
}

const show = (title: string, map: Map<string, number>) => {
  console.log(
    `\n${title} (total ${total.toFixed(0)} ms${root === undefined ? "" : ` inside ${root}`})`,
  );
  for (const [name, ms] of [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top))
    console.log(
      `${ms.toFixed(0).padStart(7)} ms ${((100 * ms) / total).toFixed(1).padStart(5)}%  ${name}`,
    );
};
show("SELF", selfByLabel);
show("INCLUSIVE", inclusiveByLabel);
