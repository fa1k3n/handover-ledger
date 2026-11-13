// The code host port: what `howl observe` needs from a code host, and nothing more.
//
// An adapter reports the state of tasks and changes as the host knows them.
// The core (observe.ts) turns that state into events, and passes over what is
// in the ledger already. So an adapter needs no memory of its own: reading the
// same state twice is harmless.

export interface Account {
  login: string;
  /** An app account of the host, not a person's. */
  bot?: boolean;
}

export interface Assignment {
  /** The host's own id of the assignment: the same every time it is read. */
  id: string;
  assignee: Account;
  at: string;
}

export interface Task {
  number: number;
  openedAt: string;
  openedBy: Account;
  assignments: Assignment[];
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

export interface Change {
  number: number;
  branch: string;
  openedAt: string;
  openedBy: Account;
  /** The head commit now, and when it was made. */
  head: { sha: string; at: string };
  /** The tasks the host links the change to. */
  tasks: number[];
  /** The paths the change touches, as the host lists them (#25). */
  files?: string[];
  /** Formal reviews of the host. */
  reviews: Review[];
  /** Comments on the change, apart from the reviews. */
  comments?: Comment[];
  closedAt?: string;
  closedBy?: Account;
  mergedAt?: string;
  mergedBy?: Account;
  updatedAt: string;
}

export interface ChecksState {
  sha: string;
  /** none: no checks at all, yet. pending: some have not finished. */
  state: "passed" | "failed" | "pending" | "none";
  /** When the last check finished, for passed and failed. */
  at?: string;
}

export interface Ref {
  kind: "task" | "change";
  number: number;
  updatedAt: string;
}

export interface CodeHost {
  /** The adapter, as it stands in `source.adapter` and at the start of every id. */
  readonly name: string;
  /** The repository, as `owner/name`. */
  readonly repository: string;
  /** The tasks and changes updated at or after `since`, or all of them. */
  listUpdated(since: string | null): Promise<Ref[]>;
  task(number: number): Promise<Task>;
  change(number: number): Promise<Change>;
  /** The checks of a commit: finishing them does not update the change at the host. */
  checks(sha: string): Promise<ChecksState>;
}
