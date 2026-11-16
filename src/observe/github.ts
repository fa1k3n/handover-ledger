// The GitHub adapter: the REST API, read only.
//
// A quiet round costs next to nothing: the list of issues is asked with `since`,
// and every call is asked again with the ETag of its last answer, so an answer
// that has not changed comes back as 304, which GitHub does not count against
// the limit. The ETags are kept in memory, for as long as `howl observe` runs.
// Details are asked only for what has changed.
// @code_class recording
import { isReviewComment, type Account, type Change, type CheckRun, type ChecksState, type CodeHost, type Comment, type Push, type Ref, type Review, type Task } from "./port.ts";

const API = "https://api.github.com";

export interface GitHubOptions {
  repository: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
  /** #28: a comment whose first line matches is a review; with none, no comment is. */
  reviewCommentPattern?: RegExp;
}

type Json = Record<string, any>;

export class GitHub implements CodeHost {
  readonly name = "github";
  readonly repository: string;
  private readonly token: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly warn: (message: string) => void;
  private readonly reviewCommentPattern: RegExp | undefined;
  private readonly cache = new Map<string, { etag: string; body: unknown; next: string | null }>();
  private lastingId: string | undefined;

  constructor(options: GitHubOptions) {
    this.repository = options.repository;
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.warn = options.warn ?? ((m) => console.error(`howl: ${m}`));
    this.reviewCommentPattern = options.reviewCommentPattern;
  }

  /** #48: the numeric id GitHub gives the repository: it stays when the repository is renamed or moved. */
  async repositoryId(): Promise<string> {
    if (this.lastingId === undefined) {
      const id = (await this.one(this.url(""))).id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) throw new Error(`GitHub gave no id for ${this.repository}`);
      this.lastingId = String(id);
    }
    return this.lastingId;
  }

  /**
   * #48: an old name is this repository when GitHub answers under it with the same id: a renamed repository answers
   * under its old name. Another id, or no such repository, is another repository. Any other failure is no answer.
   */
  async isSameRepository(name: string): Promise<boolean> {
    // A name that cannot be a repository of GitHub is not asked for.
    if (!/^[^/\s]+\/[^/\s]+$/.test(name)) return false;
    const mine = await this.repositoryId();
    let id: unknown;
    try {
      id = (await this.one(`${API}/repos/${name.split("/").map(encodeURIComponent).join("/")}`)).id;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 410) return false;
      throw e;
    }
    return typeof id === "number" && String(id) === mine;
  }

  async listUpdated(since: string | null): Promise<Ref[]> {
    const params: Record<string, string> = { state: "all", sort: "updated", direction: "asc", per_page: "100" };
    if (since !== null) params.since = since;
    const issues = await this.all(this.url("issues", params));
    return issues.map((i) => ({
      kind: i.pull_request ? "change" : "task",
      number: i.number,
      updatedAt: i.updated_at,
    }));
  }

  async task(number: number): Promise<Task> {
    const issue = await this.one(this.url(`issues/${number}`));
    const events = await this.all(this.url(`issues/${number}/events`, { per_page: "100" }));
    return defined({
      number,
      openedAt: issue.created_at,
      openedBy: account(issue.user),
      assignments: events
        // #48: given to an account that is gone, the host may tell no one: it was still given.
        .filter((e) => e.event === "assigned")
        .map((e) => defined({ id: String(e.id), assignee: account(e.assignee), by: doer(e), at: e.created_at })),
      // #45: the same events tell who took a task from whom, and who opened it again.
      unassignments: some(
        events.filter((e) => e.event === "unassigned").map((e) => defined({ id: String(e.id), assignee: account(e.assignee), by: doer(e), at: e.created_at })),
      ),
      reopenings: some(events.filter((e) => e.event === "reopened").map((e) => defined({ id: String(e.id), by: doer(e), at: e.created_at }))),
      closedAt: issue.closed_at ?? undefined,
      closedBy: issue.closed_at && issue.closed_by ? account(issue.closed_by) : undefined,
      updatedAt: issue.updated_at,
    });
  }

  async change(number: number): Promise<Change> {
    const pull = await this.one(this.url(`pulls/${number}`));
    const reviews = await this.all(this.url(`pulls/${number}/reviews`, { per_page: "100" }));
    // #20, #28: many review by commenting on the pull request; the pattern tells such a comment from the rest.
    const comments = await this.all(this.url(`issues/${number}/comments`, { per_page: "100" }));
    // #25: the paths it touches, so a change to .howl/ can be seen.
    const files = await this.all(this.url(`pulls/${number}/files`, { per_page: "100" }));
    const head = await this.one(this.url(`commits/${pull.head.sha}`));
    // #45: its issue's events tell when it was opened again and which reviews were dismissed, and by whom.
    const events = await this.all(this.url(`issues/${number}/events`, { per_page: "100" }));
    // A pull request does not say who closed it; its issue does.
    const closedBy = pull.closed_at ? (await this.one(this.url(`issues/${number}`))).closed_by : null;
    // #44: who pushed each head, and when, from the repository's activity list. The branch of a change from a fork is
    // in the fork, and this repository's list cannot hold its pushes: it has none, and its heads fall back.
    const own = pull.head?.repo != null && pull.base?.repo != null && pull.head.repo.id === pull.base.repo.id;
    const pushed = own && typeof pull.head.ref === "string" ? await this.pushes(pull.head.ref) : { pushes: undefined };
    return defined({
      number,
      branch: pull.head.ref,
      openedAt: pull.created_at,
      openedBy: account(pull.user),
      head: { sha: pull.head.sha, at: head.commit?.committer?.date ?? pull.updated_at },
      tasks: closingTasks(pull.body, this.repository),
      files: files.map((f) => f.filename).filter((f): f is string => typeof f === "string"),
      reviews: reviews.flatMap((r): Review[] => {
        const state = REVIEW_STATES[r.state];
        if (!state || !r.submitted_at) return [];
        return [defined({ id: String(r.id), by: account(r.user), state, at: r.submitted_at, sha: r.commit_id ?? undefined })];
      }),
      reopenings: some(events.filter((e) => e.event === "reopened").map((e) => defined({ id: String(e.id), by: doer(e), at: e.created_at }))),
      // #45: only what is known of the answer: that a review was dismissed, when and by whom. The fields that would name the
      // review and what it was are not read until a token has shown what the host gives (the dismissal then says no review is tied to it).
      dismissals: some(events.filter((e) => e.event === "review_dismissed").map((e) => defined({ id: String(e.id), by: doer(e), at: e.created_at }))),
      comments: (Array.isArray(comments) ? comments : [])
        .filter((c) => c && c.id !== undefined && c.user && c.created_at)
        // The text is tested here and never kept: only whether it counts as a review.
        .map((c): Comment => ({ id: String(c.id), by: account(c.user), at: c.created_at, review: isReviewComment(c.body, this.reviewCommentPattern) })),
      pushes: pushed.pushes,
      pushesRefused: pushed.refused,
      closedAt: pull.closed_at ?? undefined,
      closedBy: closedBy ? account(closedBy) : undefined,
      mergedAt: pull.merged_at ?? undefined,
      mergedBy: pull.merged_at && pull.merged_by ? account(pull.merged_by) : undefined,
      updatedAt: pull.updated_at,
    });
  }

  /**
   * #44: the pushes to a branch, oldest first, from `GET /repos/{owner}/{repo}/activity?ref=refs/heads/<branch>`. A
   * push, a forced push and the push that made the branch each give a head; the deletion of the branch and a merge give
   * none. A branch the host has no record of gives an empty list. A 403 or a 404 that is no rate limit is the list
   * refused for want of a permission (the change itself was read): no pushes, and `refused`. Anything else is thrown.
   */
  private async pushes(branch: string): Promise<{ pushes?: Push[]; refused?: true }> {
    let entries: Json[];
    try {
      entries = await this.all(this.url("activity", { ref: `refs/heads/${branch}`, per_page: "100" }));
    } catch (e) {
      const { status, limited } = e as { status?: number; limited?: boolean };
      if ((status === 403 || status === 404) && !limited) return { refused: true };
      throw e;
    }
    const found = entries
      .filter((e) => e && PUSHES.has(e.activity_type) && isCommit(e.after) && typeof e.timestamp === "string" && e.id !== undefined)
      .map((e) =>
        defined<Push>({
          id: String(e.id),
          sha: e.after,
          before: isCommit(e.before) ? e.before : undefined,
          at: e.timestamp,
          by: doer(e),
          forced: e.activity_type === "force_push" ? true : undefined,
        }),
      )
      // GitHub gives the newest first; the host's ids follow the order of the pushes within one second.
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || byNumber(a.id, b.id));
    return { pushes: found };
  }

  /**
   * #47: every run of the checks of a commit: the check runs, all of them (`filter=all`: without it the host gives only
   * the latest run of each name, and a run that failed and was run again is not there), and the states each status
   * went through (`statuses`: the combined status gives only the latest state of each context). Only the name, the
   * result and the times are read; the output of a run and its links never are. The host numbers no attempt on a
   * run, so its place among the runs of its name, by when it started, is its attempt.
   */
  async checks(sha: string): Promise<ChecksState> {
    const runs: Started[] = [];
    for (let next: string | null = this.url(`commits/${sha}/check-runs`, { filter: "all", per_page: "100" }); next !== null; ) {
      const page: { body: unknown; next: string | null } = await this.get(next);
      for (const r of ((page.body as Json).check_runs ?? []) as Json[]) {
        const done = r.status === "completed";
        runs.push({
          name: String(r.name),
          result: !done ? "pending" : ["success", "neutral", "skipped"].includes(r.conclusion) ? "passed" : "failed",
          ...(done && typeof r.completed_at === "string" ? { at: r.completed_at } : {}),
          started: typeof r.started_at === "string" ? Date.parse(r.started_at) : Infinity,
          order: Number(r.id),
        });
      }
      next = page.next;
    }
    // Each state of each status, oldest first: a pending state begins a run of its context, the next state ends it.
    const states = (await this.all(this.url(`commits/${sha}/statuses`, { per_page: "100" })))
      .map((s) => ({ context: String(s.context), state: String(s.state), at: String(s.created_at ?? s.updated_at), id: Number(s.id) }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);
    const going = new Map<string, Started>();
    for (const s of states) {
      const begun = going.get(s.context);
      if (s.state === "pending") {
        if (begun === undefined) {
          const run: Started = { name: s.context, result: "pending", started: Date.parse(s.at), order: s.id };
          going.set(s.context, run);
          runs.push(run);
        }
        continue;
      }
      const result = s.state === "success" ? "passed" : "failed";
      if (begun === undefined) runs.push({ name: s.context, result, at: s.at, started: Date.parse(s.at), order: s.id });
      else {
        begun.result = result;
        begun.at = s.at;
        going.delete(s.context);
      }
    }
    runs.sort((a, b) => a.started - b.started || a.order - b.order);
    const places = new Map<string, number>();
    return {
      sha,
      runs: runs.map((r): CheckRun => {
        const attempt = (places.get(r.name) ?? 0) + 1;
        places.set(r.name, attempt);
        return { name: r.name, result: r.result, ...(r.at !== undefined ? { at: r.at } : {}), attempt };
      }),
    };
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const query = new URLSearchParams(params).toString();
    return `${API}/repos/${this.repository}${path ? `/${path}` : ""}${query ? `?${query}` : ""}`;
  }

  private async one(url: string): Promise<Json> {
    return (await this.get(url)).body as Json;
  }

  /** Every page of a list. */
  private async all(url: string): Promise<Json[]> {
    const items: Json[] = [];
    for (let next: string | null = url; next !== null; ) {
      const page: { body: unknown; next: string | null } = await this.get(next);
      items.push(...(page.body as Json[]));
      next = page.next;
    }
    return items;
  }

  /** One GET, with the ETag of the last answer, waiting when the limit is reached. */
  private async get(url: string): Promise<{ body: unknown; next: string | null }> {
    for (let attempt = 0; ; attempt++) {
      const cached = this.cache.get(url);
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "user-agent": "howl",
        "x-github-api-version": "2022-11-28",
      };
      if (cached) headers["if-none-match"] = cached.etag;
      const response = await this.fetch(url, { headers });

      if (response.status === 304 && cached) return { body: cached.body, next: cached.next };
      if (response.ok) {
        const body = (await response.json()) as unknown;
        const next = nextPage(response.headers.get("link"));
        const etag = response.headers.get("etag");
        if (etag) this.cache.set(url, { etag, body, next });
        return { body, next };
      }

      const wait = limitWait(response);
      if (wait !== null && attempt < 5) {
        this.warn(`the limit of GitHub is reached: waiting ${Math.ceil(wait / 1000)} s`);
        await this.sleep(wait);
        continue;
      }
      // #44: a rate limit that was still on after the last wait says so, so that no caller takes it for a refusal.
      throw Object.assign(new Error(`GitHub answered ${response.status} to GET ${new URL(url).pathname}`), { status: response.status, limited: wait !== null });
    }
  }
}

const REVIEW_STATES: Record<string, Review["state"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
};

/**
 * #44: the entries of the activity list that give a head. `force_push` is named by the host's documents and was not
 * seen in a real answer; it is read in the form of the entries that were.
 */
const PUSHES = new Set(["push", "force_push", "branch_creation"]);

/** A commit, and not the zeros the host gives for no commit (a branch made or deleted). */
function isCommit(sha: unknown): sha is string {
  return typeof sha === "string" && /^[0-9a-f]{7,64}$/i.test(sha) && !/^0+$/.test(sha);
}

/** Two ids of the host, as numbers where they are. */
function byNumber(a: string, b: string): number {
  return /^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b);
}

/** The id GitHub gives `ghost`, the account it shows in place of one that was deleted. */
const GHOST_ID = 10137;

/** #48: no user, or the host's ghost, is an account that no longer exists: it is no one, and not a person called ghost. */
function account(user: Json | null | undefined): Account {
  if (!user || typeof user.login !== "string" || (user.login === "ghost" && user.id === GHOST_ID)) return { removed: true };
  return { login: user.login, bot: user.type === "Bot" };
}

/** #45: who did what an event of the host tells; none when it says nothing, an account that is gone when the user is none. */
function doer(event: Json): Account | undefined {
  return "actor" in event ? account(event.actor) : undefined;
}

/** How long to wait before asking again, when the answer says the limit is reached; else null. */
function limitWait(response: Response): number | null {
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - Date.now()) + 1000;
  }
  return null;
}

function nextPage(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * The tasks a change closes, from the closing words of its description
 * ("closes #5", "fixes owner/name#6"), in this repository only. Only the
 * numbers are kept; the description itself never is.
 */
export function closingTasks(body: string | null | undefined, repository: string): number[] {
  if (!body) return [];
  const found: number[] = [];
  const words = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+([\w.-]+\/[\w.-]+)?#(\d+)\b/gi;
  for (const match of body.matchAll(words)) {
    if (match[1] && match[1].toLowerCase() !== repository.toLowerCase()) continue;
    const n = Number(match[2]);
    if (!found.includes(n)) found.push(n);
  }
  return found;
}

/** The host and the repository, from the URL of the remote `origin` when it is at GitHub; else null. */
export function originRepository(url: string | null): { host: "github"; repository: string } | null {
  if (!url) return null;
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return match ? { host: "github", repository: `${match[1]}/${match[2]}` } : null;
}

/** #45: a list that is there only when it has something in it, so that a host with nothing to tell gives what it gave before. */
function some<T>(list: T[]): T[] | undefined {
  return list.length > 0 ? list : undefined;
}

/** #47: a run of a check or a status with what orders it: when it started and the host's id of it. */
interface Started {
  name: string;
  result: CheckRun["result"];
  at?: string;
  started: number;
  order: number;
}

/** An object without its undefined members. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
