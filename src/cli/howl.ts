// The command `howl`.
import { parseArgs } from "node:util";
import { isCode, LedgerError } from "../ledger/errors.ts";
import { ledgerPath } from "../ledger/place.ts";
import { verify } from "../ledger/verify.ts";

const USAGE = `usage: howl verify [--project <name>] [--ledger <path>]

  verify    check every line of the ledger and the chain between the lines

The ledger is the file given by --ledger, else <project>/ledger.jsonl in
$HOWL_HOME, else in $XDG_STATE_HOME/howl, else in ~/.local/state/howl.

verify ends with 0 when the ledger holds, 1 when it does not, and 2 when it
could not be read. It cannot show lines cut off the end: compare the head it
prints with one kept somewhere else.`;

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: "string" },
        ledger: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    return usage((e as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (command === undefined) return usage("no command");
  if (command !== "verify") return usage(`no command ${command}`);
  if (rest.length > 0) return usage(`verify takes no argument: ${rest.join(" ")}`);

  try {
    let path = values.ledger;
    if (path === undefined) {
      if (values.project === undefined) return usage("verify needs --project or --ledger");
      path = ledgerPath(values.project);
    }
    return runVerify(path);
  } catch (e) {
    if (e instanceof LedgerError || isCode(e, "ENOENT") || isCode(e, "EACCES") || isCode(e, "EISDIR")) {
      console.error(`howl: ${(e as Error).message}`);
      return 2;
    }
    throw e;
  }
}

function runVerify(path: string): number {
  const verdict = verify(path);
  console.log(path);
  if (!verdict.ok) {
    console.log(`line ${verdict.line}: ${verdict.faults.join("; ")}`);
    console.log(`failed at line ${verdict.line}, after ${count(verdict.lines)} that hold`);
    return 1;
  }
  console.log(`ok: ${count(verdict.lines)} checked, head ${verdict.head}`);
  if (verdict.trial) console.log("a trial: it does not count as evidence");
  return 0;
}

function count(lines: number): string {
  return `${lines} ${lines === 1 ? "line" : "lines"}`;
}

function usage(fault: string): number {
  console.error(`howl: ${fault}\n\n${USAGE}`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
