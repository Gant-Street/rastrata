import { hashCanonical } from "@rastrata/kernel";

// Independent full rebuild: sort all keys, partition by their binary strings.
// No production lookup, mutation, codec, split or root helper is used.
export function rebuildLogicalMap(domain: string, values: ReadonlyMap<string, string>) {
  const version = "rastrata-logical-map-candidate-v1";
  const nodes = new Map<string, string>();
  const hash = (kind: string, encoded: string) =>
    hashCanonical({ version, domain, kind, encoded }).digest;
  type Ref = { digest: string; min: string; max: string; count: string };
  const rows = [...values]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({
      key,
      value,
      bits: BigInt(`0x${key}`).toString(2).padStart(256, "0"),
    }));
  function tree(input: typeof rows): Ref | null {
    if (input.length === 0) return null;
    const first = input[0];
    const last = input.at(-1);
    if (!first || !last) throw new Error("Missing oracle row");
    let encoded: string;
    if (input.length === 1)
      encoded = JSON.stringify({ kind: "leaf", key: first.key, value: first.value });
    else {
      let split = 0;
      while (first.bits[split] === last.bits[split]) split++;
      const left = tree(input.filter((row) => row.bits[split] === "0"));
      const right = tree(input.filter((row) => row.bits[split] === "1"));
      if (!left || !right) throw new Error("Invalid oracle branch");
      encoded = JSON.stringify({ kind: "branch", left, right });
    }
    const digest = hash("node", encoded);
    nodes.set(digest, encoded);
    return { digest, min: first.key, max: last.key, count: String(input.length) };
  }
  const encodedRoot = JSON.stringify({ version, domain, tree: tree(rows) });
  return { encodedRoot, rootHash: hash("root", encodedRoot), nodes };
}
