// #57: what a first reader of the public repository meets: the licence, and a README whose links hold.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

test("#57: the licence is the Apache License 2.0, in LICENSE and in package.json", () => {
  const licence = read("LICENSE");
  assert.match(licence, /^\s*Apache License\n\s*Version 2\.0, January 2004\n/);
  assert.match(licence, /END OF TERMS AND CONDITIONS/);
  // The whole text, unchanged: the hash of the licence as the code host gives it.
  assert.equal(
    createHash("sha256").update(licence.replaceAll("\r\n", "\n")).digest("hex"),
    "c95bae1d1ce0235ecccd3560b772ec1efb97f348a79f0fbe0a634f0c2ccefe2c",
  );
  assert.equal(JSON.parse(read("package.json")).license, "Apache-2.0");
});

test("#57: the README links the licence and says neither that the repository is private nor that it has no licence", () => {
  const readme = read("README.md");
  assert.match(readme, /\]\(LICENSE\)/);
  assert.match(readme, /Apache License 2\.0/);
  assert.doesNotMatch(readme, /repository is private/i);
  assert.doesNotMatch(readme, /no licence yet/i);
  assert.doesNotMatch(readme, /all rights reserved/i);
});

test("#57: every file the README links to or shows is in the repository", () => {
  const readme = read("README.md");
  const targets = [
    ...[...readme.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]!),
    ...[...readme.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)].map((m) => m[1]!),
    ...[...readme.matchAll(/\b(?:src|srcset|href)="([^"]+)"/g)].map((m) => m[1]!),
  ].filter((t) => !/^(?:[a-z]+:|#)/i.test(t));
  assert.ok(targets.includes("LICENSE"));
  assert.ok(
    targets.some((t) => t.endsWith(".svg")),
    "the README shows the mark",
  );
  const missing = targets.filter((t) => !existsSync(join(ROOT, t.split("#")[0]!)));
  assert.deepEqual(missing, []);
});
