// Writes src/ledger/event.gen.ts from schema/event.v0.schema.json.
// With --check it writes nothing and fails if the file is out of date.
import { readFileSync, writeFileSync } from "node:fs";
import { compileFromFile } from "json-schema-to-typescript";

const schema = new URL("../schema/event.v0.schema.json", import.meta.url);
const target = new URL("../src/ledger/event.gen.ts", import.meta.url);

const generated = await compileFromFile(schema.pathname, {
  bannerComment: "// Generated from schema/event.v0.schema.json by `npm run gen`. Do not edit.",
  additionalProperties: false,
});

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // A missing file is out of date.
  }
  if (current !== generated) {
    console.error("src/ledger/event.gen.ts is out of date: run `npm run gen`");
    process.exit(1);
  }
} else {
  writeFileSync(target, generated);
}
