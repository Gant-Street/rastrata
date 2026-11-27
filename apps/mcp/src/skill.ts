import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mappedTools } from "./tools.ts";

export const SKILL_URI = "skill://rastrata/bookkeeping/SKILL.md";

/** Pairs every tool with its operation, so an agent that reads a lane's section in terms of tools
 * (or the runbook in terms of operations) can find the other name, and so a command-line agent can
 * call any tool's operation with `rastrata call`. It is derived from the operation catalog and the
 * tool metadata, never written by hand, so it cannot go stale. */
export function toolTable(): string {
  const rows = mappedTools().map(
    (item) =>
      `| \`${item.tool.name}\` | \`${item.operation.name}\` | ${item.operation.permission} | ${item.operation.writes ? "yes" : "no"} |`,
  );
  return [
    "## Tools and operations",
    "",
    "Each tool is one operation of the application. From the command line, `rastrata call OPERATION --input -` runs any of them with a JSON object on standard input, and `rastrata schema OPERATION` shows its exact input and output; many also have a shorter command (see `rastrata help`). `Needs` is the permission the connection must hold; `Writes` says whether the operation can change the book. Agent token management (`tokens.*`) belongs to the owner and has no tool.",
    "",
    "| Tool | Operation | Needs | Writes |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

export function loadBookkeepingSkill() {
  const text = `${readFileSync(
    resolve(import.meta.dir, "../../../plugins/rastrata/skills/bookkeeping/SKILL.md"),
    "utf8",
  ).replace(/\n*$/, "\n")}\n${toolTable()}`;
  const frontmatterText = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1];
  if (!frontmatterText) throw new Error("Bookkeeping skill requires YAML frontmatter");
  const parsed: unknown = Bun.YAML.parse(frontmatterText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid skill frontmatter");
  const frontmatter = parsed as Record<string, unknown>;
  if (
    frontmatter.name !== "bookkeeping" ||
    typeof frontmatter.description !== "string" ||
    !frontmatter.description.trim()
  )
    throw new Error("Invalid bookkeeping skill identity");
  const digest = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
  return {
    text,
    digest,
    entry: {
      uri: SKILL_URI,
      frontmatter,
      resources: [{ uri: SKILL_URI, digest }],
    },
  };
}

export type BookkeepingSkill = ReturnType<typeof loadBookkeepingSkill>;
