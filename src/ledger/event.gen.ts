// Generated from schema/event.v0.schema.json by `npm run gen`. Do not edit.

export type Name = string;

/**
 * Something that happened, and who or what did it. An event does not know its place in a ledger: that belongs to the line.
 */
export interface LedgerEvent {
  /**
   * Version of the line format.
   */
  v: 0;
  /**
   * The identity of the event. The same thing read twice gives the same id.
   */
  id: string;
  /**
   * When it happened, in UTC.
   */
  time: string;
  /**
   * What happened. A new type is added to this list, never used without it.
   */
  type:
    | "ledger.created"
    | "task.assigned"
    | "change.opened"
    | "change.updated"
    | "change.merged"
    | "tests.written"
    | "checks.passed"
    | "checks.failed"
    | "review.approved"
    | "review.changes_requested"
    | "finding.fixed"
    | "finding.dismissed"
    | "finding.left_open"
    | "level.changed"
    | "rule.broken"
    | "escalation.raised"
    | "session.started"
    | "tool.used"
    | "agent.waiting"
    | "session.stopped"
    | "session.ended"
    | "task.opened"
    | "task.closed"
    | "change.closed"
    | "change.commented"
    | "review.commented"
    | "key.issued"
    | "key.revoked"
    | "observe.started"
    | "config.changed";
  /**
   * Where the event comes from.
   */
  source: {
    /**
     * The adapter that read or received it.
     */
    adapter: string;
    /**
     * observed: read from the team's tools. claimed: sent by a session about itself.
     */
    kind: "observed" | "claimed";
  };
  /**
   * The project the event belongs to.
   */
  project: string;
  /**
   * The team member who did it.
   */
  actor?: {
    kind: "person" | "agent";
    /**
     * The identity of the team member.
     */
    id: string;
  };
  /**
   * The team the event belongs to.
   */
  team?: string;
  /**
   * For an agent: the session the event comes from.
   */
  session?: string;
  /**
   * For an agent: the model ID of the session.
   */
  model?: string;
  /**
   * For an agent: the effort of the session.
   */
  effort?: string;
  /**
   * For an agent: its role in this session, a name the team chooses (review, build, test, fix ...).
   */
  role?: string;
  /**
   * For an agent: the role prompt.
   */
  prompt?: {
    /**
     * The file of the role prompt.
     */
    file: string;
    /**
     * SHA-256 of the content of the file.
     */
    sha256: string;
  };
  /**
   * Version of the rules in force: the commit they ran from.
   */
  rules?: string;
  /**
   * The repository the event concerns.
   */
  repo?: string;
  /**
   * The task, as the tracker names it.
   */
  task?: string;
  /**
   * The merge or pull request, as the code host names it.
   */
  change?: string;
  /**
   * The branch of the change or of the working directory.
   */
  branch?: string;
  /**
   * The head commit.
   */
  sha?: string;
  /**
   * IDs of the requirements the event is linked to.
   */
  requirements?: Name[];
  /**
   * IDs of the clauses of those requirements.
   */
  clauses?: Name[];
  /**
   * Names of the tests that cover them.
   */
  tests?: Name[];
  /**
   * The level of autonomy in force.
   */
  level?: number;
  /**
   * The code class.
   */
  class?: string;
  /**
   * The Ed25519 signature of the event's fixed form without sig, by the key of an assignment (key.issued) or by the issuer.
   */
  sig?: {
    /**
     * The key's id: the SHA-256 of its raw public key.
     */
    key: string;
    /**
     * The signature, base64url.
     */
    value: string;
  };
  /**
   * What belongs to this type of event only.
   */
  data?: {
    [k: string]: unknown;
  };
}
