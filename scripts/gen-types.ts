// Writes the TypeScript types in src/ledger/ from the schemas in schema/.
// With --check it writes nothing and fails if a file is out of date.
// @code_class rules
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";
import { classByPath, findClasses } from "../src/howl/classes.ts";

const pairs = [
  ["event.v0.schema.json", "event.gen.ts"],
  ["line.v0.schema.json", "line.gen.ts"],
] as const;

const settings = findClasses(fileURLToPath(new URL("..", import.meta.url)));
const check = process.argv.includes("--check");
let stale = false;

for (const [schema, types] of pairs) {
  const source = fileURLToPath(new URL(`../schema/${schema}`, import.meta.url));
  const target = new URL(`../src/ledger/${types}`, import.meta.url);
  // The code class of the generated file, by its path, as a header line (#60).
  const code = settings && classByPath(settings.classes, `src/ledger/${types}`);
  const generated = await compileFromFile(source, {
    bannerComment:
      `// Generated from schema/${schema} by \`npm run gen\`. Do not edit.` + (code ? `\n// @code_class ${code}` : ""),
    additionalProperties: false,
  });
  if (!check) {
    writeFileSync(target, generated);
    continue;
  }
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // A missing file is out of date.
  }
  if (current !== generated) {
    console.error(`src/ledger/${types} is out of date: run \`npm run gen\``);
    stale = true;
  }
}

if (stale) process.exit(1);
