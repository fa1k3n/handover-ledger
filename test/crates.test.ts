// The crates of the Rust `howl` have not grown: the test of issue #137, as dependencies.test.ts is for npm.
// @code_class tests
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** The names in the sections of Cargo.toml that hold direct dependencies. */
function crates(toml: string): string[] {
  const names: string[] = [];
  let section = "";
  for (const raw of toml.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!;
      // A table of its own per crate: [dependencies.name].
      const own = /^(?:dev-|build-)?dependencies\.(.+)$/.exec(section);
      if (own) names.push(own[1]!);
      continue;
    }
    if (/^(?:dev-|build-)?dependencies$/.test(section) && /^[A-Za-z0-9_-]+\s*=/.test(line)) names.push(line.split("=")[0]!.trim());
  }
  return names;
}

test("#137: the direct dependencies of the crate are the list in this test", () => {
  const toml = readFileSync(new URL("../rust/Cargo.toml", import.meta.url), "utf8");
  // A piece that adds a crate adds it here and names it.
  // #139: serde and serde_json read JSON as JSON.parse does, ryu-js writes numbers as ECMAScript does, sha2 hashes.
  assert.deepEqual(crates(toml), ["serde", "serde_json", "ryu-js", "sha2"]);
});

test("#139: serde_json's arbitrary_precision is never asked for", () => {
  // Without it every number has an f64, as JSON.parse makes it, and fixed_form relies on that. Cargo.lock does not
  // record features, so a crate that turns it on through feature unification is caught by the Rust tests instead
  // (rust/tests/fixed.rs: 1e400 would be read, and numbers above 2^53 kept whole).
  const toml = readFileSync(new URL("../rust/Cargo.toml", import.meta.url), "utf8");
  assert.doesNotMatch(toml, /arbitrary_precision/);
});

test("#137: the crate is built with the toolchain the repository pins", () => {
  const pin = readFileSync(new URL("../rust-toolchain.toml", import.meta.url), "utf8");
  assert.match(pin, /^channel = "\d+\.\d+\.\d+"$/m, "an exact version");
  assert.match(pin, /"rustfmt"/);
  assert.match(pin, /"clippy"/);
});
