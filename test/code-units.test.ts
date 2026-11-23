// #138: names are ordered by code units, never by the locale: the same order in every place and in both versions.
// @code_class tests
import assert from "node:assert/strict";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readTar, writeTar } from "../src/export/tar.ts";
import { fixedForm } from "../src/ledger/fixed.ts";
import { folder, howl } from "./helpers.ts";
import { activityEvents, m, writeStory } from "./story.ts";

/** The files of the bundle `howl export` writes for `args`. */
function exportOf(ledger: string, args: string[]): { files: Map<string, Buffer> } {
  const out = join(folder(), "bundle.tar.gz");
  const r = howl(["export", "--ledger", ledger, ...args, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  return { files: readTar(readFileSync(out)) };
}

test("#138: howl show lists the tools of a session by code units: Bash, Edit, Read, then bash", () => {
  const ledger = writeStory();
  const [first] = activityEvents();
  appendFileSync(join(ledger, "..", "activity.jsonl"), `${fixedForm({ ...first!, id: "lower-case-tool", time: m(5), data: { tool: "bash", target: "make" } })}\n`);
  const run = howl(["show", "12", "--ledger", ledger, "--utc"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /tool calls: Bash 2, Edit 1, Read 1, bash 1\n/);
});

test("#138: the tar writer puts names in the order of code units, capitals before small letters", () => {
  const files = new Map([
    ["b.txt", Buffer.from("b")],
    ["README.txt", Buffer.from("r")],
    ["a.txt", Buffer.from("a")],
    ["B.txt", Buffer.from("B")],
  ]);
  assert.deepEqual([...readTar(writeTar(files)).keys()], ["B.txt", "README.txt", "a.txt", "b.txt"]);
});

test("#138: a bundle lists its files, in the tar and in the manifest, by code units: README.txt before checkpoints/, ledger.jsonl and manifest.json", () => {
  const { files } = exportOf(writeStory(), ["--change", "30"]);
  const tar = [...files.keys()];
  assert.deepEqual(tar, [...tar].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal(tar[0], "README.txt", tar.join(" "));
  const manifest = JSON.parse(files.get("manifest.json")!.toString()) as { files: Record<string, string> };
  const named = Object.keys(manifest.files);
  assert.deepEqual(named, [...named].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal(named[0], "README.txt");
});

/** The files under `src`, with their text. */
function sources(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

test("#138: no source orders by the locale: localeCompare is nowhere in src", () => {
  const where = sources(join(import.meta.dirname, "..", "src")).filter((p) => /localeCompare|Intl\.Collator/.test(readFileSync(p, "utf8")));
  assert.deepEqual(where, []);
});
