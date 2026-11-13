// The ledger's head kept outside the machine that writes it (#18). A checkpoint
// names the number of lines and the hash of the last; kept in a git ref of the
// observed repository and pushed to its remote, or in a file, or printed. A
// ledger cut back or rewritten with a new chain no longer matches it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerError } from "../ledger/errors.ts";
import { fixedForm } from "../ledger/fixed.ts";
import { hashLine } from "../ledger/ledger.ts";

export const REF = "refs/howl/checkpoints";
const NAMESPACE = "howl-checkpoint";

export interface Checkpoint {
  project: string;
  lines: number;
  head: string;
  time: string;
  howl: string;
}

/** The whole lines of a ledger file, as bytes. */
function wholeLines(path: string): Buffer[] {
  const bytes = readFileSync(path);
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      out.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  return out;
}

export function checkpointOf(ledger: string, version: string, now = new Date()): Checkpoint {
  const lines = wholeLines(ledger);
  if (lines.length === 0) throw new LedgerError(`${ledger}: the ledger is empty`);
  const first = JSON.parse(lines[0]!.toString("utf8")) as { event?: { project?: string } };
  return { project: first.event?.project ?? "", lines: lines.length, head: hashLine(lines.at(-1)!), time: now.toISOString(), howl: version };
}

/** The checkpoint in its fixed form, as it is kept and signed. */
export function checkpointText(c: Checkpoint): string {
  return `${fixedForm(c).toString("utf8")}\n`;
}

function run(cmd: string, args: string[], opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}): { ok: boolean; out: string; err: string } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, input: opts.input, env: opts.env ?? process.env, encoding: "utf8", timeout: 60_000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** An SSH signature of the text (`ssh-keygen -Y sign`, namespace howl-checkpoint). */
export function signText(text: string, keyFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), "howl-sign-"));
  try {
    const file = join(dir, "checkpoint.json");
    writeFileSync(file, text);
    const r = run("ssh-keygen", ["-Y", "sign", "-f", keyFile, "-n", NAMESPACE, file]);
    if (!r.ok) throw new LedgerError(`ssh-keygen could not sign with ${keyFile}: ${r.err}`);
    return readFileSync(`${file}.sig`, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether the signature of the text holds for a principal of the allowed-signers file. */
export function signatureHolds(text: string, sig: string, signers: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "howl-verify-"));
  try {
    const file = join(dir, "checkpoint.json.sig");
    writeFileSync(file, sig);
    const who = run("ssh-keygen", ["-Y", "find-principals", "-s", file, "-f", signers]);
    if (!who.ok || !who.out) return false;
    for (const principal of who.out.split("\n")) {
      if (run("ssh-keygen", ["-Y", "verify", "-f", signers, "-I", principal, "-n", NAMESPACE, "-s", file], { input: text }).ok) return true;
    }
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "howl", GIT_AUTHOR_EMAIL: "howl@localhost", GIT_COMMITTER_NAME: "howl", GIT_COMMITTER_EMAIL: "howl@localhost" };

/** A commit on refs/howl/checkpoints holding the checkpoint (and its signature), pushed to origin when there is one. Touches no branch and no working tree. */
export function anchorToGit(repo: string, c: Checkpoint, text: string, sig?: string): { commit: string; pushed: boolean } {
  const blob = (content: string) => {
    const r = run("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: content });
    if (!r.ok) throw new LedgerError(`git hash-object failed in ${repo}: ${r.err}`);
    return r.out;
  };
  const entries = [`100644 blob ${blob(text)}\tcheckpoint.json`];
  if (sig !== undefined) entries.push(`100644 blob ${blob(sig)}\tcheckpoint.json.sig`);
  const tree = run("git", ["mktree"], { cwd: repo, input: `${entries.join("\n")}\n` });
  if (!tree.ok) throw new LedgerError(`git mktree failed: ${tree.err}`);
  const parent = run("git", ["rev-parse", "-q", "--verify", REF], { cwd: repo });
  const commit = run("git", ["commit-tree", tree.out, ...(parent.ok ? ["-p", parent.out] : []), "-m", `checkpoint ${c.project}: ${c.lines} lines, head ${c.head.slice(0, 12)}`], { cwd: repo, env: GIT_ENV });
  if (!commit.ok) throw new LedgerError(`git commit-tree failed: ${commit.err}`);
  const update = run("git", ["update-ref", REF, commit.out, ...(parent.ok ? [parent.out] : [])], { cwd: repo });
  if (!update.ok) throw new LedgerError(`git update-ref failed: ${update.err}`);
  const origin = run("git", ["remote", "get-url", "origin"], { cwd: repo });
  if (!origin.ok) return { commit: commit.out, pushed: false };
  const push = run("git", ["push", "-q", "origin", `${REF}:${REF}`], { cwd: repo });
  if (!push.ok) throw new LedgerError(`the checkpoint is committed but could not be pushed: ${push.err}`);
  return { commit: commit.out, pushed: true };
}

/** The latest checkpoint of refs/howl/checkpoints, fetched from origin first when there is one. */
export function checkpointFromGit(repo: string): { text: string; sig?: string } {
  const origin = run("git", ["remote", "get-url", "origin"], { cwd: repo });
  if (origin.ok) run("git", ["fetch", "-q", "origin", `+${REF}:${REF}`], { cwd: repo });
  const text = run("git", ["show", `${REF}:checkpoint.json`], { cwd: repo });
  if (!text.ok) throw new LedgerError(`no checkpoint on ${REF} in ${repo}`);
  const sig = run("git", ["show", `${REF}:checkpoint.json.sig`], { cwd: repo });
  return { text: `${text.out}\n`, sig: sig.ok ? `${sig.out}\n` : undefined };
}

/** Whether the ledger still holds the line the checkpoint names. */
export function checkLedger(ledger: string, c: Checkpoint): { ok: true; message: string } | { ok: false; message: string } {
  const lines = wholeLines(ledger);
  if (lines.length < c.lines) {
    return { ok: false, message: `checkpoint: lines lost: the ledger has ${lines.length} lines, the checkpoint of ${c.time} names ${c.lines}` };
  }
  if (hashLine(lines[c.lines - 1]!) !== c.head) {
    return { ok: false, message: `checkpoint: line changed: line ${c.lines} is not the line the checkpoint of ${c.time} holds` };
  }
  return { ok: true, message: `checkpoint: line ${c.lines} holds, as of ${c.time}` };
}
