// The code host port: what `howl observe` needs from a code host, and nothing more.
//
// An adapter reports the state of tasks and changes as the host knows them.
// The core (observe.ts) turns that state into events, and passes over what is
// in the ledger already. So an adapter needs no memory of its own: reading the
// same state twice is harmless.
// @code_class recording

/**
 * Who did a thing at the host. An account that no longer exists (#48) is `{ removed: true }`: the host tells no
 * one, and the ledger names no one for it. Every removed account is not one person.
 */
export type Account =
  | {
      login: string;
      /** An app account of the host, not a person's. */
      bot?: boolean;
    }
  | { removed: true };

export interface Assignment {
  /** The host's own id of the assignment: the same every time it is read. */
  id: string;
  /** The one who got the task. */
  assignee: Account;
  /** #45: the one who gave it, when the host says; none when it does not. */
  by?: Account;
  at: string;
}

/** #45: a task taken from someone. */
export interface Unassignment {
  /** The host's own id of it. */
  id: string;
  /** The one it was taken from. */
  assignee: Account;
  /** The one who took it, when the host says. */
  by?: Account;
  at: string;
}

/** #45: a task or a change opened again. */
export interface Reopening {
  /** The host's own id of it. */
  id: string;
  /** The one who opened it again, when the host says. */
  by?: Account;
  at: string;
}

/**
 * #45: a formal review that was dismissed. Its text is never kept. What the host says of the review it dismissed
 * differs: a host that names none gives none of `review`, `state` and `reviewed`, and the dismissal then says that no
 * review is tied to it.
 */
export interface Dismissal {
  /** The host's own id of the dismissal. */
  id: string;
  /** The host's id of the review that was dismissed, when the host says. */
  review?: string;
  /** What the review was, when the host says. */
  state?: "approved" | "changes_requested" | "commented";
  /** The one who dismissed it, when the host says. */
  by?: Account;
  at: string;
  /**
   * The review itself, for one the host no longer lists among its reviews, when the host names it in the dismissal:
   * with `state`, enough to write the review that was dismissed.
   */
  reviewed?: { by?: Account; at: string; sha?: string };
}

export interface Task {
  number: number;
  openedAt: string;
  openedBy: Account;
  assignments: Assignment[];
  /** #45: a host that tells nothing of them gives none; so does a file from before. */
  unassignments?: Unassignment[];
  reopenings?: Reopening[];
  closedAt?: string;
  closedBy?: Account;
  updatedAt: string;
}

export interface Review {
  /** The host's own id of the review. */
  id: string;
  by: Account;
  state: "approved" | "changes_requested" | "commented";
  at: string;
  /** The commit the review was of. */
  sha?: string;
}

/**
 * A comment on a change that is not a formal review (#28). Whether it counts as
 * a review is told by the adapter from its text, which is never kept.
 */
export interface Comment {
  /** The host's own id of the comment. */
  id: string;
  by: Account;
  at: string;
  /** Whether its first line matches the project's `review_comment_pattern`. */
  review: boolean;
}

/** Whether a comment counts as a review: its first line matches the pattern. With no pattern, none does. */
export function isReviewComment(body: unknown, pattern: RegExp | undefined): boolean {
  if (pattern === undefined || typeof body !== "string") return false;
  return pattern.test(body.split(/\r?\n/, 1)[0]!);
}

/**
 * #44: a push to the branch of a change, as the host records it: the head it made, when, and who pushed. One push of
 * several commits is one push, with the last as its head.
 */
export interface Push {
  /** The host's own id of the push. */
  id: string;
  /** The head after the push. */
  sha: string;
  /** The head before it, when the host says and there was one. */
  before?: string;
  /** When it was pushed: the host's time of the push, not the commit's. */
  at: string;
  /** The account that pushed, when the host says; not the agent behind it. */
  by?: Account;
  /** A push that replaced the head with one that does not follow from it. */
  forced?: boolean;
}

export interface Change {
  number: number;
  branch: string;
  openedAt: string;
  openedBy: Account;
  /** The head commit now, and when it was made. */
  head: { sha: string; at: string };
  /**
   * #44: the pushes to the change's branch, oldest first, as far back as the host keeps them. None when the host
   * tells none: a change from a fork, or a host that has no record of pushes. Its heads are then the ones a round sees.
   */
  pushes?: Push[];
  /**
   * #44: the host refused the list of pushes for want of a permission, though it gave the change. The heads then fall
   * back, and `howl observe` says on every round that the list cannot be read.
   */
  pushesRefused?: true;
  /** The tasks the host links the change to. */
  tasks: number[];
  /** The paths the change touches, as the host lists them (#25). */
  files?: string[];
  /** Formal reviews of the host. */
  reviews: Review[];
  /** Comments on the change, apart from the reviews. */
  comments?: Comment[];
  /** #45: the times it was opened again, and the reviews that were dismissed. */
  reopenings?: Reopening[];
  dismissals?: Dismissal[];
  closedAt?: string;
  closedBy?: Account;
  mergedAt?: string;
  mergedBy?: Account;
  updatedAt: string;
}

/**
 * #47: one run of a check, as the host gives it. Only what the ledger keeps: the name, the result, when it finished
 * and which attempt it was. The output of a check, its text and its links are never read.
 */
export interface CheckRun {
  /** The name of the check, as the host gives it. None for a verdict that names no check (the older file of the local host). */
  name?: string;
  /** passed: success, neutral or skipped. failed: any other result of a run that finished. pending: not finished. */
  result: "passed" | "failed" | "pending";
  /** When it finished, for passed and failed. */
  at?: string;
  /**
   * Which attempt it was: its place, from 1, among the runs of its name on the commit, by when they started. The host
   * numbers no attempt on a run, so the adapter counts them.
   */
  attempt: number;
}

/** #47: the runs of the checks of a commit, all of them and not the latest of each name. No runs: no checks, yet. */
export interface ChecksState {
  sha: string;
  runs: CheckRun[];
}

export interface Ref {
  kind: "task" | "change";
  number: number;
  updatedAt: string;
}

export interface CodeHost {
  /** The adapter, as it stands in `source.adapter` and at the start of every id. */
  readonly name: string;
  /** The repository, as `owner/name`: what people read, and what `repo` of an event holds. It can change. */
  readonly repository: string;
  /**
   * The host's own id of the repository (#48), as text: the same after a rename or a move to another owner. The ids
   * of events are made from it. It may need a call to the host, so it is asked for once the observer starts.
   */
  repositoryId(): Promise<string>;
  /**
   * Whether a name the ledger's older ids were made from is this repository, as the host says: true when it was its
   * name before, false when it is another repository or none. It throws when the host cannot answer, and nothing
   * observed is written until it can. Never asked for the name in `repository`.
   */
  isSameRepository(name: string): Promise<boolean>;
  /** The tasks and changes updated at or after `since`, or all of them. */
  listUpdated(since: string | null): Promise<Ref[]>;
  task(number: number): Promise<Task>;
  change(number: number): Promise<Change>;
  /** The runs of the checks of a commit (#47): finishing them, or running them again, does not update the change at the host. */
  checks(sha: string): Promise<ChecksState>;
}
