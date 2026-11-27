/** What the Members page does, as a state machine with no screen in it: who is in the open workspace and as what, who has been asked in, and the few things a person may do
 * about that (ask someone in, take an invitation back, change a role, take someone out, leave). The Solid view (routes/settings/members.tsx) draws the state and calls these
 * functions; the tests drive them with a stand-in for the account layer. Nothing here knows about the DOM.
 *
 * The control plane decides everything and says why when it refuses (control-worker.md); the page repeats its rule about who may do what (`mayManage`) so that it offers only
 * what will be accepted, never so that it decides. After each change the whole list is read again: the page shows what the control plane holds, not what it expects. */
import type {
  Account,
  Member,
  PendingInvitation,
  Person,
  Result,
  Role,
  WorkspaceSummary,
} from "./account";

type Calls = Pick<
  Account,
  "session" | "workspace" | "invite" | "revokeInvitation" | "changeRole" | "removeMember" | "scope"
>;

export const ROLES: readonly Role[] = ["owner", "admin", "accountant", "member"];

/** A role in a person's words, and what it allows (the pod's `ROLE_PERMISSIONS`, in member-access.md). */
export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  owner: "Owner",
  admin: "Administrator",
  accountant: "Accountant",
  member: "Member",
};
export const ROLE_ALLOWS: Readonly<Record<Role, string>> = {
  owner: "Everything, including who has access.",
  admin: "Everything in the books. Adds and removes accountants and members.",
  accountant: "Reads, drafts, posts, corrects and closes.",
  member: "Reads and drafts.",
};

/** What a role may do about other people's access: an owner anyone's; an administrator the accountants' and members'; the rest nobody's. */
export function mayManage(actor: Role, target: Role): boolean {
  return (
    actor === "owner" || (actor === "admin" && (target === "accountant" || target === "member"))
  );
}

/** The roles a person may ask someone in as. (Nobody is invited as an owner: an owner is made from a member.) */
export function rolesToInvite(actor: Role): readonly Exclude<Role, "owner">[] {
  return (["admin", "accountant", "member"] as const).filter((role) => mayManage(actor, role));
}

/** The roles a person may change another's to; none when they may not change that person's at all. */
export function rolesToGive(actor: Role, target: Role): readonly Role[] {
  return mayManage(actor, target) ? ROLES.filter((role) => mayManage(actor, role)) : [];
}

export interface MemberRow extends Member {
  readonly you: boolean;
  /** The roles this person's may be changed to by the person looking; empty means the role is only shown. */
  readonly roles: readonly Role[];
  /** Taking this person out, or for the person looking at their own row, leaving. */
  readonly canRemove: boolean;
}

export interface MembersView {
  readonly me: Person;
  readonly role: Role;
  readonly workspace: WorkspaceSummary;
  readonly members: readonly MemberRow[];
  /** Who has been asked in and has not come: only an owner or an administrator is told. */
  readonly invitations: readonly PendingInvitation[];
  /** The roles the person may ask someone in as; empty hides the form. */
  readonly inviteAs: readonly Exclude<Role, "owner">[];
  /** Some of the people listed are still being put into the books: the view asks `refresh` every few seconds. */
  readonly waiting: boolean;
  /** Said under the list when the person looking is the only owner (they cannot leave, nor be taken out). */
  readonly soleOwner: boolean;
  readonly error?: string;
  readonly notice?: string;
}

export type MembersState =
  | { readonly step: "loading" }
  | { readonly step: "problem"; readonly message: string }
  | { readonly step: "ready"; readonly view: MembersView }
  /** The person has left the workspace: the page goes to the one that lets them choose another. */
  | { readonly step: "left" };

const SHAPE_OF_AN_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface MembersOptions {
  readonly account: Calls;
  /** Where the browser goes next. */
  readonly go: (path: string) => void;
  /** Forget the workspace that is open (after leaving it). */
  readonly forget: () => void;
  /** The address of the page that lets a person choose a workspace. */
  readonly startPath: string;
}

export class MembersController {
  #state: MembersState = { step: "loading" };
  readonly #listeners = new Set<(state: MembersState) => void>();
  readonly #options: MembersOptions;
  #me: Person | null = null;

  constructor(options: MembersOptions) {
    this.#options = options;
  }

  get state(): MembersState {
    return this.#state;
  }

  subscribe(listener: (state: MembersState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: MembersState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  /** Read who is in. Called when the page opens, and by the view again every few seconds while someone is being added. */
  async load(): Promise<void> {
    const first = this.#state.step !== "ready";
    const view = await this.#read();
    if (view === null) return;
    if (!first && this.#state.step === "ready") {
      // A read that only refreshes keeps what the page said last (a notice or an error stays until the next action).
      const { error, notice } = this.#state.view;
      this.#set({
        step: "ready",
        view: { ...view, ...(error ? { error } : {}), ...(notice ? { notice } : {}) },
      });
      return;
    }
    this.#set({ step: "ready", view });
  }

  /** The same read, for the view's timer. */
  refresh(): Promise<void> {
    return this.load();
  }

  /** Read the workspace and build what the page shows. On a failure the page is told (when nothing is shown yet) and null comes back. */
  async #read(): Promise<MembersView | null> {
    const { account } = this.#options;
    const id = account.scope();
    if (id === null) {
      this.#set({ step: "problem", message: "No workspace is open." });
      return null;
    }
    if (this.#me === null) {
      const session = await account.session();
      if (!session.ok || session.value === null) {
        this.#fail(session.ok ? "You are signed out. Sign in again." : session.message);
        return null;
      }
      this.#me = session.value;
    }
    const detail = await account.workspace(id);
    if (!detail.ok) {
      this.#fail(detail.message);
      return null;
    }
    const me = this.#me;
    // The workspace is shown as the person who asks has it, so its role is theirs.
    const role: Role = detail.value.workspace.role;
    const owners = detail.value.members.filter((member) => member.role === "owner").length;
    const soleOwner = role === "owner" && owners === 1;
    return {
      me,
      role,
      workspace: detail.value.workspace,
      members: detail.value.members.map((member) => {
        const you = member.userId === me.id;
        const onlyOwner = member.role === "owner" && owners === 1;
        return {
          ...member,
          you,
          // The only owner stays one: there is nothing to choose.
          roles: onlyOwner ? [] : rolesToGive(role, member.role),
          // Leaving is anyone's own; taking out is the roles' above. The only owner can do neither.
          canRemove: (you || mayManage(role, member.role)) && !onlyOwner,
        };
      }),
      invitations: detail.value.invitations ?? [],
      inviteAs: rolesToInvite(role),
      waiting: detail.value.members.some((member) => !member.ready),
      soleOwner,
    };
  }

  /** A failure to read is shown in place of the page only while there is nothing to show; later it is a line above what is there. */
  #fail(message: string): void {
    if (this.#state.step === "ready")
      this.#set({ step: "ready", view: { ...this.#state.view, error: message } });
    else this.#set({ step: "problem", message });
  }

  #say(change: Partial<Pick<MembersView, "error" | "notice">>): void {
    if (this.#state.step !== "ready") return;
    const { error: _error, notice: _notice, ...rest } = this.#state.view;
    this.#set({ step: "ready", view: { ...rest, ...change } });
  }

  /** Ask someone in. */
  async invite(email: string, role: Exclude<Role, "owner">): Promise<boolean> {
    if (this.#state.step !== "ready") return false;
    const address = email.trim();
    if (!SHAPE_OF_AN_ADDRESS.test(address)) {
      this.#say({ error: "Enter the email address of the person to invite." });
      return false;
    }
    if (!this.#state.view.inviteAs.includes(role)) {
      this.#say({ error: "You may not invite someone with that role." });
      return false;
    }
    const answer = await this.#options.account.invite(this.#state.view.workspace.id, address, role);
    return this.#afterChange(
      answer,
      `We sent an invitation to ${address}. The link works for seven days.`,
    );
  }

  async revoke(invitationId: string): Promise<boolean> {
    if (this.#state.step !== "ready") return false;
    const answer = await this.#options.account.revokeInvitation(invitationId);
    return this.#afterChange(answer, "The invitation was taken back.");
  }

  async setRole(userId: string, role: Role): Promise<boolean> {
    if (this.#state.step !== "ready") return false;
    const view = this.#state.view;
    const row = view.members.find((member) => member.userId === userId);
    if (!row || row.role === role) return false;
    if (!row.roles.includes(role)) {
      this.#say({ error: "You may not give that role." });
      return false;
    }
    const answer = await this.#options.account.changeRole(view.workspace.id, userId, role);
    return this.#afterChange(answer, `${row.email} is now ${ROLE_LABEL[role].toLowerCase()}.`);
  }

  /** Take someone out of the workspace; for the person's own row, leave it. */
  async remove(userId: string): Promise<boolean> {
    if (this.#state.step !== "ready") return false;
    const view = this.#state.view;
    const row = view.members.find((member) => member.userId === userId);
    if (!row?.canRemove) {
      this.#say({ error: "That person cannot be taken out." });
      return false;
    }
    const answer = await this.#options.account.removeMember(view.workspace.id, userId);
    if (answer.ok && row.you) {
      this.#options.forget();
      this.#set({ step: "left" });
      this.#options.go(this.#options.startPath);
      return true;
    }
    return this.#afterChange(answer, `${row.email} no longer has access.`);
  }

  async #afterChange(answer: Result<unknown>, notice: string): Promise<boolean> {
    if (!answer.ok) {
      this.#say({ error: answer.message });
      // A refusal can mean the page was out of date (someone else changed the list): read it again, keeping the reason on screen.
      await this.load();
      if (this.#state.step === "ready")
        this.#set({ step: "ready", view: { ...this.#state.view, error: answer.message } });
      return false;
    }
    await this.load();
    this.#say({ notice });
    return true;
  }
}
