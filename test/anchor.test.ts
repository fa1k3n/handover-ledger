// The ledger's head kept outside the machine that writes it: the tests of issue #18.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { folder, git, howl, PROJECT, rawLines, workspace } from "./helpers.ts";
import { LocalHost } from "./local-host.ts";
import { writeStory } from "./story.ts";

const checkpointOf = (ledger: string) => {
  const r = howl(["anchor", "--ledger", ledger, "--to", "-"]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as { project: string; lines: number; head: string; time: string; howl: string };
};

test("#18: a checkpoint names the number of lines and the head howl verify prints", () => {
  const ledger = writeStory();
  const c = checkpointOf(ledger);
  const v = howl(["verify", "--ledger", ledger]);
  assert.equal(c.lines, rawLines(ledger).length);
  assert.ok(v.stdout.includes(`head ${c.head}`), v.stdout);
  assert.equal(c.project, PROJECT);
});

test("#18: a ledger that grew passes; one cut back fails 'lines lost'; one rewritten with a new chain fails 'line changed'", () => {
  const ledger = writeStory();
  const file = join(folder(), "c.json");
  assert.equal(howl(["anchor", "--ledger", ledger, "--to", `file:${file}`]).status, 0);
  const before = readFileSync(ledger);
  assert.equal(howl(["verify", "--ledger", ledger, "--checkpoint", file]).status, 0, "unchanged passes");

  // Cut back: the chain of the first lines still holds, the end is gone.
  const lines = rawLines(ledger);
  writeFileSync(ledger, lines.slice(0, 5).map((l) => `${l}\n`).join(""));
  const cut = howl(["verify", "--ledger", ledger, "--checkpoint", file]);
  assert.equal(cut.status, 1);
  assert.match(cut.stdout, /lines lost/);

  // Rewritten: another ledger with its own consistent chain, as long as the first.
  writeFileSync(ledger, readFileSync(writeStory()));
  const rewritten = howl(["verify", "--ledger", ledger, "--checkpoint", file]);
  assert.equal(rewritten.status, 1);
  assert.match(rewritten.stdout, /line changed/);
  writeFileSync(ledger, before);
});

test("#18: a ledger grown after the checkpoint passes", async () => {
  const ledger = writeStory();
  const file = join(folder(), "c.json");
  assert.equal(howl(["anchor", "--ledger", ledger, "--to", `file:${file}`]).status, 0);
  const { openLedger } = await import("../src/ledger/ledger.ts");
  const { event } = await import("./helpers.ts");
  const w = openLedger(ledger, { project: PROJECT });
  w.append(event());
  w.close();
  assert.equal(howl(["verify", "--ledger", ledger, "--checkpoint", file]).status, 0);
});

test("#18: anchoring to git makes a commit on refs/howl/checkpoints, pushes it, and touches no branch and no working tree", () => {
  const remote = folder();
  git(remote, "init", "-q", "--bare");
  const ws = workspace();
  git(ws.root, "init", "-q");
  git(ws.root, "commit", "-q", "--allow-empty", "-m", "start");
  git(ws.root, "remote", "add", "origin", remote);
  const head = git(ws.root, "rev-parse", "HEAD");
  const status = git(ws.root, "status", "--porcelain");
  const ledger = writeStory();
  const run = () => howl(["anchor", "--ledger", ledger], { cwd: ws.root, env: ws.env });
  assert.equal(run().status, 0, run().stderr);
  assert.equal(run().status, 0);
  assert.equal(git(ws.root, "rev-parse", "HEAD"), head, "no branch moved");
  assert.equal(git(ws.root, "status", "--porcelain"), status, "the working tree is untouched");
  const log = git(remote, "log", "--format=%s", "refs/howl/checkpoints").split("\n");
  assert.ok(log.length >= 2, "each anchor is a commit, in a history");
  const v = howl(["verify", "--ledger", ledger, "--checkpoint", "git"], { cwd: ws.root, env: ws.env });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /checkpoint: line \d+ holds/);
});

test("#18: a signed checkpoint verifies against its allowed signers, and fails with another key or after a change", () => {
  const dir = folder();
  const key = join(dir, "team");
  const other = join(dir, "other");
  for (const k of [key, other]) assert.equal(spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", k]).status, 0);
  const signers = join(dir, "signers");
  writeFileSync(signers, `team ${readFileSync(`${key}.pub`, "utf8")}`);
  const otherSigners = join(dir, "other-signers");
  writeFileSync(otherSigners, `team ${readFileSync(`${other}.pub`, "utf8")}`);
  const ledger = writeStory();
  const file = join(dir, "c.json");
  const a = howl(["anchor", "--ledger", ledger, "--to", `file:${file}`, "--sign", key]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(howl(["verify", "--ledger", ledger, "--checkpoint", file, "--signers", signers]).status, 0);
  assert.equal(howl(["verify", "--ledger", ledger, "--checkpoint", file, "--signers", otherSigners]).status, 1);
  const c = JSON.parse(readFileSync(file, "utf8"));
  c.lines = c.lines - 1;
  writeFileSync(file, JSON.stringify(c));
  const changed = howl(["verify", "--ledger", ledger, "--checkpoint", file, "--signers", signers]);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /signature/);
});

test("#18: observe --anchor-every anchors once after a round with new lines, and not again before the time", () => {
  const remote = folder();
  git(remote, "init", "-q", "--bare");
  const dir = folder();
  const host = new LocalHost(dir);
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\n` });
  git(ws.root, "init", "-q");
  git(ws.root, "commit", "-q", "--allow-empty", "-m", "start");
  git(ws.root, "remote", "add", "origin", remote);
  host.task({ number: 1, openedAt: "2026-01-01T00:00:00Z", openedBy: { login: "alice" }, assignments: [], updatedAt: "2026-01-01T00:00:00Z" });
  const observe = () => howl(["observe", "--once", "--anchor-every", "60"], { cwd: ws.root, env: ws.env });
  assert.equal(observe().status, 0);
  assert.equal(observe().status, 0);
  const log = git(remote, "log", "--format=%s", "refs/howl/checkpoints").split("\n").filter(Boolean);
  assert.equal(log.length, 1);
});
