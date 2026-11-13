// Fails when the built dashboard is over 300 kB gzipped (issue #12).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const LIMIT = 300 * 1024;
const root = new URL("../dist/dashboard", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const total = files(root).reduce((sum, path) => sum + gzipSync(readFileSync(path)).length, 0);
console.log(`dashboard: ${(total / 1024).toFixed(1)} kB gzipped, limit ${LIMIT / 1024} kB`);
if (total > LIMIT) process.exitCode = 1;
