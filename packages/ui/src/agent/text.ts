import { formatAge, formatDate } from "../format";
import { EXPIRING_SOON_DAYS } from "./summary";
import type {
  AgentChoice,
  AgentChoiceId,
  AgentConnectedRow,
  AgentTokenRow,
  TokenPermission,
} from "./types";
import { permissionWords, words } from "./words";

/** The three choices, in the order the page offers them: the usual one first. */
export const AGENT_CHOICES: readonly AgentChoice[] = [
  { id: "draft", permissions: ["read", "draft"] },
  { id: "read-only", permissions: ["read"] },
  { id: "bookkeeper", permissions: ["read", "draft", "post"] },
];

/** The choices a person may give: those whose every permission they hold themselves. */
export function choicesFor(grantable: readonly TokenPermission[]): readonly AgentChoice[] {
  return AGENT_CHOICES.filter((choice) =>
    choice.permissions.every((permission) => grantable.includes(permission)),
  );
}

/** `Read, Draft, Post`: names, never codes, in the order a person thinks of them. */
export function permissionList(permissions: readonly TokenPermission[]): string {
  return permissions.map((permission) => permissionWords[permission].name).join(", ");
}

/** What a set of permissions is called: the choice it is ("Prepare"), or its permissions by name for a
 * set made another way (the command line, the API). */
export function accessName(permissions: readonly TokenPermission[]): string {
  const held = [...permissions].sort().join(",");
  const choice = AGENT_CHOICES.find((item) => [...item.permissions].sort().join(",") === held);
  return choice ? words.choices[choice.id].name : permissionList(permissions);
}

/** What to say to an agent that was given a choice. */
export const askFor = (choice: AgentChoiceId): string => words.choices[choice].ask;

/** The command a person runs. A workspace at the service's own address needs only the code; any other
 * (a copy for trying things out) names its address, since the command line would not find it. */
export function connectCommand(code: string, origin?: string | undefined): string {
  return origin === undefined || origin === "https://app.rastrata.com"
    ? `rastrata connect ${code}`
    : `rastrata connect ${code} --endpoint ${origin}`;
}

/** The command on a computer that runs the service itself: no code, since its owner is the one asking. */
export const localConnectCommand = (choice: AgentChoiceId): string =>
  choice === "draft" ? "rastrata connect" : `rastrata connect --preset ${choice}`;

/** The rows of the list from the tokens of a book: those that work, and those that ran out in the last
 * thirty days (so that an agent that stopped is explained). One a person revoked is their own doing. */
export function connectedRows(
  tokens: readonly AgentTokenRow[],
  now: Date,
  owner?: (token: AgentTokenRow) => string | undefined,
): readonly AgentConnectedRow[] {
  const recent = now.getTime() - 30 * 86_400_000;
  return tokens
    .filter(
      (token) =>
        token.status === "active" ||
        (token.status === "expired" && Date.parse(token.expiresAt) >= recent),
    )
    .map((token) => ({
      id: token.id,
      name: token.label,
      permissions: token.permissions,
      status: token.status === "active" ? ("active" as const) : ("expired" as const),
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
      owner: owner?.(token),
    }));
}

/** The one line under an agent's name: what it may do, when it was last used, when it ends if that is
 * soon, and whose it is when it is someone else's. */
export function connectedLine(row: AgentConnectedRow, now: Date): string {
  const parts = [accessName(row.permissions)];
  if (row.status === "expired") parts.push(words.ended(formatDate(row.expiresAt)));
  else {
    parts.push(row.lastUsedAt ? words.used(formatAge(row.lastUsedAt, now)) : words.notUsed);
    if (Date.parse(row.expiresAt) - now.getTime() <= EXPIRING_SOON_DAYS * 86_400_000)
      parts.push(words.ends(formatDate(row.expiresAt)));
  }
  if (row.owner) parts.push(row.owner);
  return parts.join(" · ");
}
