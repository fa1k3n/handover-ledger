// Pseudonyms for people. A person's account at the code host never goes into
// the ledger: a pseudonym does, made up the first time the account is seen and
// kept in people.json beside the ledger. Removing a row there cuts the link
// between the ledger and the person.
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LedgerError } from "../ledger/errors.ts";

export class People {
  private readonly path: string;
  private readonly names: Map<string, string>;
  private changed = false;

  constructor(path: string) {
    this.path = path;
    let text: string | null = null;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.names = new Map();
    if (text !== null) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new LedgerError(`${path}: not JSON; it holds the pseudonyms of people and is not overwritten`);
      }
      for (const [account, pseudonym] of Object.entries(value as Record<string, unknown>)) {
        if (typeof pseudonym === "string") this.names.set(account, pseudonym);
      }
    }
  }

  /** The pseudonym of an account, made up the first time it is seen. */
  pseudonym(account: string): string {
    let name = this.names.get(account);
    if (name === undefined) {
      const taken = new Set(this.names.values());
      do name = `person-${randomBytes(4).toString("hex")}`;
      while (taken.has(name));
      this.names.set(account, name);
      this.changed = true;
    }
    return name;
  }

  /** Writes people.json when a pseudonym was made up. */
  save(): void {
    if (!this.changed) return;
    const temporary = join(dirname(this.path), ".people.json.tmp");
    writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(this.names), null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.changed = false;
  }
}
