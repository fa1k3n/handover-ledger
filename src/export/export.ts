// An evidence bundle for a change, a task or a period (#19), and its check offline.
// The bundle holds the ledger up to its head (a hash chain proves a line only with
// every line before it), the lines selected, the timeline, the checkpoints that
// cover the head, a manifest of hashes and a README. Never the activity file or
// people.json.
// @code_class evidence
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLedger, REF, signatureHolds, type Checkpoint } from "../anchor/anchor.ts";
import { LedgerError } from "../ledger/errors.ts";
import { hashLine } from "../ledger/ledger.ts";
import { LEDGER_FILE } from "../ledger/names.ts";
import { verify } from "../ledger/verify.ts";
import { readWhole } from "../read/reader.ts";
import { show, type Asked } from "../read/show.ts";
import { readTar } from "./tar.ts";

export type Selection = { kind: "change" | "task"; id: string } | { since: string; until: string };

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The checkpoints on refs/howl/checkpoints of `repo` that name a line within the first `lines`. */
function checkpointsOf(repo: string | undefined, lines: number): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  if (!repo) return found;
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 30_000 });
  const log = git("log", "--format=%H", REF);
  if (log.status !== 0) return found;
  for (const commit of log.stdout.trim().split("\n").filter(Boolean)) {
    const text = git("show", `${commit}:checkpoint.json`);
    if (text.status !== 0) continue;
    const c = JSON.parse(text.stdout) as Checkpoint;
    if (c.lines > lines) continue;
    found.set(`checkpoints/${commit.slice(0, 12)}.json`, Buffer.from(text.stdout));
    const sig = git("show", `${commit}:checkpoint.json.sig`);
    if (sig.status === 0) found.set(`checkpoints/${commit.slice(0, 12)}.json.sig`, Buffer.from(sig.stdout));
  }
  return found;
}

export function buildBundle(ledger: string, selection: Selection, opts: { version: string; repo?: string; now?: Date }): Map<string, Buffer> {
  // Read once: the bytes that go into the bundle and the events selected from them are of the same moment.
  const whole = readWhole(ledger);
  const lines = whole.bytes;
  if (lines.length === 0) throw new LedgerError(`${ledger}: the ledger is empty`);
  const ledgerBytes = Buffer.concat(lines.flatMap((l) => [l, Buffer.from("\n")]));
  // A bundle is made of a ledger that can be read: every line, or none.
  const unread = lines.findIndex((_, i) => whole.lines[i]?.n !== i + 1);
  if (unread !== -1) throw new LedgerError(`${ledger}: line ${unread + 1} cannot be read: run \`howl verify\``);
  const events = whole.lines.map((r) => ({ n: r.n!, event: r.event }));
  const files = new Map<string, Buffer>();
  // The bundle holds the ledger under the name it has in the project's folder.
  files.set(LEDGER_FILE, ledgerBytes);

  let selected: number[];
  let asked: string;
  if ("kind" in selection) {
    asked = `${selection.kind}:${selection.id}`;
    // The ledger alone: the activity file never goes into a bundle.
    const shown = show(
      events.map((e) => e.event).filter((e) => e.type !== "ledger.created"),
      { kind: selection.kind, id: selection.id } as Asked,
      null,
    );
    if (shown === null) throw new LedgerError(`nothing in the ledger names ${asked}`);
    const ids = new Set(shown.events.map((e) => e.id));
    selected = events.filter((e) => ids.has(e.event.id)).map((e) => e.n);
    files.set("timeline.json", Buffer.from(`${JSON.stringify(shown, null, 2)}\n`));
  } else {
    const from = Date.parse(selection.since);
    const to = Date.parse(selection.until);
    if (Number.isNaN(from) || Number.isNaN(to) || to < from) throw new LedgerError("give --since and --until as times, the first before the second");
    asked = `${selection.since}..${selection.until}`;
    selected = events.filter((e) => e.event.type !== "ledger.created" && Date.parse(e.event.time) >= from && Date.parse(e.event.time) <= to).map((e) => e.n);
  }
  files.set("selection.json", Buffer.from(`${JSON.stringify({ asked, lines: selected }, null, 2)}\n`));
  for (const [name, bytes] of checkpointsOf(opts.repo, lines.length)) files.set(name, bytes);

  const head = hashLine(lines.at(-1)!);
  files.set(
    "README.txt",
    Buffer.from(
      `An evidence bundle of Handover Ledger: ${asked}.\n\n` +
        `${LEDGER_FILE}    the ledger from its first line up to its head\n` +
        "selection.json  what was asked, and the numbers of the lines it selected\n" +
        "timeline.json   the timeline of the change or task (not for a period)\n" +
        "checkpoints/    the checkpoints that cover the head, kept outside the machine that wrote the ledger\n" +
        "manifest.json   the SHA-256 of every other file\n\n" +
        "Check it offline:  howl verify --bundle <this file> [--signers <allowed signers>]\n",
    ),
  );
  const manifest = {
    howl: opts.version,
    exported: (opts.now ?? new Date()).toISOString(),
    asked,
    lines: lines.length,
    head,
    files: Object.fromEntries([...files.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, b]) => [name, sha(b)])),
  };
  files.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return files;
}

/** The check of a bundle, offline: the manifest, the chain, the selected lines, the checkpoints. */
export function verifyBundle(bytes: Buffer, signers?: string): { ok: boolean; messages: string[] } {
  const messages: string[] = [];
  let ok = true;
  const fail = (m: string) => {
    ok = false;
    messages.push(m);
  };
  const files = readTar(bytes);
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) return { ok: false, messages: ["manifest.json: missing"] };
  const json = <T>(name: string, b: Buffer | undefined, fallback: T): T => {
    if (b === undefined) return fallback;
    try {
      return JSON.parse(b.toString()) as T;
    } catch {
      fail(`${name}: not JSON`);
      return fallback;
    }
  };
  const manifest = json<{ files: Record<string, string>; head: string; lines: number }>("manifest.json", manifestBytes, { files: {}, head: "", lines: 0 });
  for (const [name, hash] of Object.entries(manifest.files)) {
    const b = files.get(name);
    if (!b) fail(`${name}: missing`);
    else if (sha(b) !== hash) fail(`${name}: does not match the manifest`);
  }
  for (const name of files.keys()) if (name !== "manifest.json" && !(name in manifest.files)) fail(`${name}: not in the manifest`);

  const ledgerBytes = files.get(LEDGER_FILE);
  if (!ledgerBytes) return { ok: false, messages: [...messages, `${LEDGER_FILE}: missing`] };
  const dir = mkdtempSync(join(tmpdir(), "howl-bundle-"));
  try {
    const path = join(dir, LEDGER_FILE);
    writeFileSync(path, ledgerBytes);
    const chain = verify(path);
    if (!chain.ok) fail(`${LEDGER_FILE}: line ${chain.line}: ${chain.faults.join("; ")}`);
    else {
      messages.push(`${LEDGER_FILE}: ${chain.lines} lines, the chain holds, head ${chain.head}`);
      if (chain.head !== manifest.head) fail(`${LEDGER_FILE}: its head is not the manifest's`);
    }
    const selection = json<{ lines: number[] }>("selection.json", files.get("selection.json"), { lines: [] });
    const count = chain.ok ? chain.lines : 0;
    const outside = selection.lines.filter((n) => !(Number.isInteger(n) && n >= 1 && n <= count));
    for (const n of outside) fail(`selection.json: line ${n} is not in the ledger`);
    if (outside.length === 0) messages.push(`bundle: ${selection.lines.length} selected lines in the ledger`);

    const checkpoints = [...files.keys()].filter((k) => k.startsWith("checkpoints/") && k.endsWith(".json"));
    if (checkpoints.length === 0) messages.push("bundle: no checkpoint: checked by its chain alone");
    for (const name of checkpoints) {
      const text = files.get(name)!.toString();
      const c = json<Checkpoint | null>(name, files.get(name), null);
      if (c === null) continue;
      const result = checkLedger(path, c);
      if (!result.ok) fail(`${name}: ${result.message}`);
      else messages.push(`${name}: ${result.message}`);
      if (signers !== undefined) {
        const sig = files.get(`${name}.sig`);
        if (!sig || !signatureHolds(text, sig.toString(), signers)) fail(`${name}: its signature does not hold for the allowed signers`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { ok, messages };
}
