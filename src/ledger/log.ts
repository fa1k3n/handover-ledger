// The log that follows the repository (#27, #216): the branch howl/log of the observed repository. Its tree holds
// only `events/<aa>/<hash>.json`, a file per event: the event in its fixed form (fixed.ts), `<hash>` the SHA-256 of
// that form in lowercase hex, `<aa>` its first two digits. The same event recorded twice is one file, so two trees
// merge by union. The branch is read with git's plumbing and never checked out: the working tree, the index and HEAD
// are never touched. This module only reads. Its Rust twin is rust/src/ledger/log.rs.
// @code_class evidence
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { LedgerError } from "./errors.ts";
import { fixedForm } from "./fixed.ts";
import { checkDepth, MAX_DEPTH, parseJson } from "./json.ts";
import { eventFaults, type LedgerEvent } from "./schema.ts";

/** The branch, and its full reference. */
export const LOG_BRANCH = "howl/log";
export const LOG_REF = `refs/heads/${LOG_BRANCH}`;

/** The one form of a path on the log. */
const PATH = /^events\/([0-9a-f]{2})\/([0-9a-f]{64})\.json$/;

/** The faults of a file, in the words of both versions. */
export const LOG_FAULTS = {
  notFile: "not a file: only files belong on the log",
  place: "only events/<aa>/<hash>.json belongs on the log",
  name: "the name is not the hash of the content",
  json: "the content is not JSON",
  fixed: "the content is not the fixed form of its event",
};

/** A file of the log's tree, as git gives it. */
export interface LogFile {
  path: string;
  /** Whether it is a plain file (a blob, not a link): only then is `bytes` read. */
  plain: boolean;
  bytes: Buffer;
}

/** What a file of the log holds, and what is wrong with it. */
export interface LogEntry {
  path: string;
  /** The event it holds, when it holds one the event schema accepts. */
  event?: LedgerEvent;
  /** The SHA-256 of the file's content: of the event's fixed form when the file holds no fault. */
  hash: string;
  /** The content as stored. */
  raw: string;
  faults: string[];
}

/** Runs git in `repo`; its output as bytes, or null when git fails or is not there. Standard error is dropped. */
function run(repo: string, args: string[], input?: Buffer): Buffer | null {
  const result = spawnSync("git", args, {
    cwd: repo,
    input,
    timeout: 60_000,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout !== null ? result.stdout : null;
}

/** The commit at the head of howl/log in `repo`, or null when there is no such branch or no repository. */
export function logHead(repo: string): string | null {
  const out = run(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${LOG_REF}^{commit}`]);
  const head = out?.toString("utf8").trim() ?? "";
  return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
}

/** Every file of the tree of `commit`, in git's order, with its content when it is a plain file. */
export function logFiles(repo: string, commit: string): LogFile[] {
  const listed = run(repo, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  if (listed === null) throw new LedgerError(`git cannot read the tree of ${LOG_BRANCH} at ${commit}`);
  const entries = listed
    .toString("utf8")
    .split("\0")
    .filter((e) => e !== "")
    .map((e) => {
      const tab = e.indexOf("\t");
      const [mode, type, object] = e.slice(0, tab).split(" ") as [string, string, string];
      return { path: e.slice(tab + 1), plain: type === "blob" && mode !== "120000", object };
    });
  const blobs = entries.filter((e) => e.plain);
  const contents = new Map<string, Buffer>();
  if (blobs.length > 0) {
    const out = run(repo, ["cat-file", "--batch"], Buffer.from(blobs.map((b) => `${b.object}\n`).join(""), "utf8"));
    if (out === null) throw new LedgerError(`git cannot read the files of ${LOG_BRANCH} at ${commit}`);
    let at = 0;
    for (const blob of blobs) {
      const end = out.indexOf(0x0a, at);
      const size = Number(out.subarray(at, end).toString("utf8").split(" ")[2]);
      contents.set(blob.object, out.subarray(end + 1, end + 1 + size));
      at = end + 1 + size + 1;
    }
  }
  return entries.map((e) => ({ path: e.path, plain: e.plain, bytes: e.plain ? contents.get(e.object)! : Buffer.alloc(0) }));
}

/** What one file of the log holds, and its faults: its place, its name, its content. */
export function examine(file: LogFile): LogEntry {
  const hash = createHash("sha256").update(file.bytes).digest("hex");
  const raw = file.bytes.toString("utf8");
  if (!file.plain) return { path: file.path, hash, raw, faults: [LOG_FAULTS.notFile] };
  const faults: string[] = [];
  const form = PATH.exec(file.path);
  if (form === null || form[2]!.slice(0, 2) !== form[1]) faults.push(LOG_FAULTS.place);
  else if (form[2] !== hash) faults.push(LOG_FAULTS.name);
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
    // An event stands one level down in a line of the ledger: it is held to the depth an event may have there.
    checkDepth(text, MAX_DEPTH - 1);
    value = parseJson(text);
  } catch {
    return { path: file.path, hash, raw, faults: [...faults, LOG_FAULTS.json] };
  }
  const refused = eventFaults(value);
  if (refused.length > 0) return { path: file.path, hash, raw, faults: [...faults, ...refused.map((f) => `event: ${f}`)] };
  if (!fixedForm(value).equals(file.bytes)) faults.push(LOG_FAULTS.fixed);
  return { path: file.path, event: value as LedgerEvent, hash, raw, faults };
}

/** The log of `repo` as it stands: its head and what each file holds. Null when there is no branch howl/log. */
export function readLog(repo: string): { head: string; entries: LogEntry[] } | null {
  const head = logHead(repo);
  if (head === null) return null;
  return { head, entries: logFiles(repo, head).map(examine) };
}

/** The commit that last wrote `path` on the log up to `head`: the one that holds the file as it stands. `head` when git cannot say. */
export function commitOfFile(repo: string, head: string, path: string): string {
  const out = run(repo, ["--literal-pathspecs", "log", "-1", "--format=%H", head, "--", path]);
  const commit = out?.toString("utf8").trim() ?? "";
  return commit === "" ? head : commit;
}

/** The verdict on the log: a line for each fault, and how many files were checked. */
export interface LogVerdict {
  head: string;
  files: number;
  faults: string[];
}

/**
 * The check of the log of `repo`, for `howl verify`: each file is named by the hash of its content, stands in
 * `events/<aa>/`, and holds the fixed form of an event the schema accepts; a fault names the file and the commit that
 * holds it. Two files with one id and different content stay two events, and the repeated id is a fault (#199). Null
 * when there is no branch howl/log.
 */
export function verifyLog(repo: string): LogVerdict | null {
  const log = readLog(repo);
  if (log === null) return null;
  const faults: string[] = [];
  for (const entry of log.entries) {
    if (entry.faults.length > 0) faults.push(`${entry.path}, commit ${commitOfFile(repo, log.head, entry.path)}: ${entry.faults.join("; ")}`);
  }
  const byId = new Map<string, Map<string, string>>();
  for (const entry of log.entries) {
    if (entry.event === undefined) continue;
    const held = byId.get(entry.event.id) ?? new Map<string, string>();
    if (!held.has(entry.hash)) held.set(entry.hash, entry.path);
    byId.set(entry.event.id, held);
  }
  for (const [id, held] of byId) {
    if (held.size > 1) faults.push(`id ${id} is in more than one file, with different content: ${[...held.values()].join(", ")}`);
  }
  return { head: log.head, files: log.entries.length, faults };
}
