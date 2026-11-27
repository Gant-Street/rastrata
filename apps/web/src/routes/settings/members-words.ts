import { formatInstant } from "@rastrata/ui/format";

/** The words of Settings, Members (members.tsx). The roles and what each allows are in members-controller.ts, beside the rules they describe. */
export const membersWords = {
  title: "Members",
  notHere: "People are not managed here",
  notHereBody:
    "This copy of Rastrata is used by one person. Workspaces with several people are on the hosted service.",
  loading: "Reading who has access…",
  left: "You left the workspace. Opening the list of your workspaces…",
  failed: "The members could not be read",
  retry: "Try again",
  people: "People with access",
  peopleCaption: (workspace: string) => `People who can open ${workspace}`,
  you: "You",
  joining: "Being added…",
  roleOf: (email: string) => `Role of ${email}`,
  remove: "Remove",
  removeNamed: (email: string) => `Remove ${email}`,
  leave: "Leave",
  keep: "Cancel",
  removeTitle: (email: string) => `Remove ${email}?`,
  removeBody: "They lose access to these books at once. What they entered stays in the books.",
  leaveTitle: "Leave this workspace?",
  leaveBody: (workspace: string) =>
    `You will no longer be able to open ${workspace}. An owner or an administrator there can invite you again.`,
  soleOwner: "You are the only owner. Make someone else an owner before you leave.",
  invite: "Invite someone",
  inviteBody: "They get an email with a link that works for seven days.",
  emailLabel: "Email address",
  roleLabel: "Role",
  sendInvitation: "Send invitation",
  sending: "Sending…",
  waiting: "Waiting to join",
  waitingCaption: "People who were invited and have not joined",
  expiresUntil: (instant: string) => `link works until ${formatInstant(instant)}`,
  revoke: "Take back",
  revokeNamed: (email: string) => `Take back the invitation to ${email}`,
};
