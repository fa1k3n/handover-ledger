// howl export and howl verify --bundle: the tests of issue #19.
// @code_class tests
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readTar, writeTar } from "../src/export/tar.ts";
import { show } from "../src/read/show.ts";
import { folder, git, howl, PROJECT, rawLines, workspace } from "./helpers.ts";
import { openLedger } from "../src/ledger/ledger.ts";
import { activityEvents, m, REVIEWER, SHA, writeStory } from "./story.ts";

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

/** A ledger where an agent's session is on a branch and a person's account opens the change. */
function writeMatched(): string {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  const base = { v: 0 as const, project: PROJECT };
  writer.append({ ...base, id: "s-1", time: m(1), type: "session.started", source: { adapter: "claude-code-hook", kind: "claimed" }, actor: { kind: "agent", id: "agent-1" }, session: "s1", branch: "task-5-x", data: { source: "startup" } });
  writer.append({ ...base, id: "o-1", time: m(5), type: "change.opened", source: { adapter: "local", kind: "observed" }, actor: { kind: "person", id: REVIEWER }, change: "40", branch: "task-5-x", sha: SHA.a, task: "5", data: { seen: m(5) } });
  writer.close();
  return path;
}

test("#33: a bundle from a trial ledger says so in its manifest, its README and when it is checked, and still passes", () => {
  const ledger = writeStory();
  const made = howl(["export", "--ledger", ledger, "--change", "30", "--out", join(folder(), "b.tar.gz")]);
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /a trial: it does not count as evidence/);
  const { out, files } = exportOf(ledger, ["--change", "30"]);
  const manifest = JSON.parse(files.get("manifest.json")!.toString()) as { trial?: boolean };
  assert.equal(manifest.trial, true);
  assert.match(files.get("README.txt")!.toString().split("\n").slice(0, 3).join("\n"), /a trial: it does not count as evidence/i);
  const r = howl(["verify", "--bundle", out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.at(-2), "ok: the bundle holds");
  assert.equal(lines.at(-1), "a trial: it does not count as evidence");
});

test("#33: a change opened through a person's account by a matched agent: the timeline names the person, inferred.json the agent and the rule", () => {
  const ledger = writeMatched();
  const { files } = exportOf(ledger, ["--change", "40"]);
  const timeline = files.get("timeline.json")!.toString();
  assert.ok(timeline.includes(REVIEWER));
  // The session's own events name the agent; the match is no part of the timeline.
  const shown = JSON.parse(timeline) as { changes: { opened?: { actor?: { id: string }; by?: string } }[] };
  assert.equal(shown.changes[0]!.opened!.actor!.id, REVIEWER);
  assert.ok(!/"by"/.test(timeline), "the timeline holds no matched agent");
  const inferred = JSON.parse(files.get("inferred.json")!.toString()) as { event: string; agent: string; sessions: string[]; via?: string; rule: { by: string; branch?: string; before_ms: number; after_ms: number } }[];
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0]!.event, "o-1");
  assert.equal(inferred[0]!.agent, "agent-1");
  assert.deepEqual(inferred[0]!.sessions, ["s1"]);
  assert.equal(inferred[0]!.via, REVIEWER);
  assert.equal(inferred[0]!.rule.by, "branch");
  assert.equal(inferred[0]!.rule.branch, "task-5-x");
  assert.equal(typeof inferred[0]!.rule.before_ms, "number");
  assert.equal(typeof inferred[0]!.rule.after_ms, "number");
  assert.match(files.get("README.txt")!.toString(), /inferred\.json[^\n]*not evidence/);
});

test("#33: a bundle with no match has an empty inferred.json, and the manifest lists it", () => {
  // Change 31 is opened by the agent itself: nothing to match.
  const { files } = exportOf(writeStory(), ["--change", "31"]);
  assert.ok(files.has("inferred.json"), "a bundle of a change holds inferred.json");
  assert.deepEqual(JSON.parse(files.get("inferred.json")!.toString()), []);
  const manifest = JSON.parse(files.get("manifest.json")!.toString()) as { files: Record<string, string> };
  assert.equal(manifest.files["inferred.json"], sha(files.get("inferred.json")!));
});

/** The bundle with its manifest changed by `change`, and the manifest's own hashes left as they were. */
function withManifest(files: Map<string, Buffer>, change: (m: Record<string, unknown>) => void): string {
  const changed = new Map(files);
  const manifest = JSON.parse(changed.get("manifest.json")!.toString()) as Record<string, unknown>;
  change(manifest);
  changed.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  const file = join(folder(), "m.tar.gz");
  writeFileSync(file, writeTar(changed, true));
  return file;
}

test("#33: a manifest that has lost trial, or says false, while the ledger says trial: the bundle does not hold", () => {
  const { files } = exportOf(writeStory(), ["--change", "30"]);
  for (const edit of [(m: Record<string, unknown>) => delete m.trial, (m: Record<string, unknown>) => (m.trial = false)]) {
    const r = howl(["verify", "--bundle", withManifest(files, edit)]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /the bundle does not hold/);
    assert.match(r.stdout, /manifest\.json: trial does not say what the ledger says/);
    assert.match(r.stdout, /a trial: it does not count as evidence/);
  }
});

test("#33: a bundle made before this step, with no trial in its manifest, holds and says trial from its ledger", () => {
  const { files } = exportOf(writeStory(), ["--change", "30"]);
  // As an older howl made it: no trial in the manifest, and no inferred.json.
  const old = new Map(files);
  old.delete("inferred.json");
  const manifest = JSON.parse(old.get("manifest.json")!.toString()) as { files: Record<string, string>; trial?: boolean };
  delete manifest.trial;
  delete manifest.files["inferred.json"];
  old.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  const file = join(folder(), "old.tar.gz");
  writeFileSync(file, writeTar(old, true));
  const r = howl(["verify", "--bundle", file]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stdout.trim().split("\n").at(-1), "a trial: it does not count as evidence");
});

test("#33: the README of a trial starts by saying so, and says what inferred.json holds and that neither file is of a period", () => {
  const { files } = exportOf(writeStory(), ["--change", "30"]);
  const readme = files.get("README.txt")!.toString();
  assert.match(readme.split("\n")[0]!, /^A trial: it does not count as evidence/);
  assert.match(readme, /inferred\.json +what howl matched[^\n]*head[^\n]*not for a period/);
  assert.match(readme, /timeline\.json +[^\n]*not for a period/);
});

test("#33: a bundle of a period has no inferred.json, and its manifest does not list one", () => {
  const { files } = exportOf(writeStory(), ["--since", "2026-01-01T00:00:00Z", "--until", "2026-01-02T00:00:00Z"]);
  assert.ok(!files.has("inferred.json"));
  assert.ok(!("inferred.json" in (JSON.parse(files.get("manifest.json")!.toString()) as { files: object }).files));
});
