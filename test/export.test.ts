// howl export and howl verify --bundle: the tests of issue #19.
// @code_class tests
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readTar, writeTar } from "../src/export/tar.ts";
import { show } from "../src/read/show.ts";
import { folder, git, howl, rawLines, workspace } from "./helpers.ts";
import { activityEvents, writeStory } from "./story.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function exportOf(ledger: string, args: string[], cwd?: string) {
  const out = join(folder(), "bundle.tar.gz");
  const r = howl(["export", "--ledger", ledger, ...args, "--out", out], { cwd });
  assert.equal(r.status, 0, r.stderr);
  return { out, files: readTar(readFileSync(out)) };
}

test("#19: the tar writer and reader keep names and bytes", () => {
  const files = new Map([
    ["a.json", Buffer.from('{"a":1}\n')],
    ["dir/b.txt", Buffer.alloc(1500, 0x61)],
  ]);
  assert.deepEqual(readTar(writeTar(files)), files);
});

test("#19: an export of a change holds the ledger up to the head, selects the lines howl show uses, and its manifest holds", () => {
  const ledger = writeStory();
  const { files } = exportOf(ledger, ["--change", "30"]);
  assert.deepEqual(readFileSync(ledger), files.get("ledger.jsonl"));
  const selection = JSON.parse(files.get("selection.json")!.toString()) as { asked: string; lines: number[] };
  const inLedger = rawLines(ledger)
    .map((l) => (JSON.parse(l) as { event: Parameters<typeof show>[0][number] }).event)
    .filter((e) => e.type !== "ledger.created");
  const ids = new Set(show(inLedger, { kind: "change", id: "30" }, null)!.events.map((e) => e.id));
  const expected = rawLines(ledger)
    .map((l, i) => ({ n: i + 1, id: (JSON.parse(l) as { event: { id: string } }).event.id }))
    .filter((x) => ids.has(x.id))
    .map((x) => x.n);
  assert.deepEqual(selection.lines, expected);
  assert.ok(files.has("timeline.json") && files.has("README.txt"));
  const manifest = JSON.parse(files.get("manifest.json")!.toString()) as { files: Record<string, string>; head: string };
  for (const [name, hash] of Object.entries(manifest.files)) assert.equal(sha(files.get(name)!), hash, name);
});

test("#19: howl verify --bundle passes a fresh bundle, and names the file when one byte changed", () => {
  const ledger = writeStory();
  const { out, files } = exportOf(ledger, ["--task", "12"]);
  const ok = howl(["verify", "--bundle", out]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /bundle: \d+ selected lines in the ledger/);
  assert.match(ok.stdout, /checked by its chain alone/);
  for (const name of ["ledger.jsonl", "timeline.json", "selection.json"]) {
    const changed = new Map(files);
    const bytes = Buffer.from(changed.get(name)!);
    bytes[10] = bytes[10] === 0x41 ? 0x42 : 0x41;
    changed.set(name, bytes);
    const file = join(folder(), "changed.tar.gz");
    writeFileSync(file, writeTar(changed, true));
    const r = howl(["verify", "--bundle", file]);
    assert.equal(r.status, 1, name);
    assert.match(r.stdout, new RegExp(`${name.replace(".", "\\.")}: does not match the manifest`));
  }
});

test("#19: a selected line that is not in the ledger fails", () => {
  const ledger = writeStory();
  const { files } = exportOf(ledger, ["--change", "30"]);
  const changed = new Map(files);
  const selection = JSON.parse(changed.get("selection.json")!.toString());
  selection.lines.push(99999);
  changed.set("selection.json", Buffer.from(JSON.stringify(selection)));
  const manifest = JSON.parse(changed.get("manifest.json")!.toString());
  manifest.files["selection.json"] = sha(changed.get("selection.json")!);
  changed.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  const file = join(folder(), "b.tar.gz");
  writeFileSync(file, writeTar(changed, true));
  const r = howl(["verify", "--bundle", file]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /line 99999 is not in the ledger/);
});

test("#19: no line of the activity file and nothing of people.json goes into a bundle", () => {
  const ledger = writeStory();
  writeFileSync(join(ledger, "..", "people.json"), JSON.stringify({ "real-login": "person-0a0a0a0a" }));
  const { files } = exportOf(ledger, ["--since", "2026-01-01T00:00:00Z", "--until", "2026-01-02T00:00:00Z"]);
  const all = Buffer.concat([...files.values()]).toString();
  assert.ok(!all.includes("real-login"), "people.json stays home");
  for (const e of activityEvents()) assert.ok(!all.includes(e.id), `activity ${e.id} stays home`);
  assert.ok(!files.has("timeline.json"), "a period has no timeline");
});

test("#19: a bundle whose checkpoint does not match its head fails", () => {
  const ws = workspace();
  git(ws.root, "init", "-q");
  git(ws.root, "commit", "-q", "--allow-empty", "-m", "start");
  // A checkpoint of another ledger, with as many lines, on the repository's ref.
  const other = writeStory();
  assert.equal(howl(["anchor", "--ledger", other], { cwd: ws.root, env: ws.env }).status, 0);
  const ledger = writeStory();
  const { out, files } = exportOf(ledger, ["--change", "30"], ws.root);
  assert.ok([...files.keys()].some((k) => k.startsWith("checkpoints/")), "the checkpoint is in the bundle");
  const r = howl(["verify", "--bundle", out]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /line changed/);
});
