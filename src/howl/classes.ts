// Code classes: which class each file has, by path (`classes` in .howl/howl.yml)
// and from the file's own header (`class_header`), and the two compared.
//
// `classes` is read here and not by `findProject`, so that the hook stays as
// quick as it is. Only `name` and `paths` of a class are read; `owner`, `level`
// and `checks` are passed over until a step needs them.
// @code_class recording
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./git.ts";
import { plain, topLevel } from "./project.ts";

export interface CodeClass {
  name: string;
  paths: string[];
}

export interface ClassSettings {
  /** The folder that holds `.howl/`. */
  root: string;
  /** From the highest demand to the lowest. */
  classes: CodeClass[];
  /** A regular expression; its first group is the class. */
  header?: string;
  /** Globs of the files that must carry the header. */
  headerIn: string[];
}

/** How many lines at the top of a file are searched for the header. */
export const HEADER_LINES = 50;

/** The classes of the nearest `.howl/howl.yml` at or above `dir`, or null when it has none. */
export function findClasses(dir: string): ClassSettings | null {
  for (let at = dir; ; at = dirname(at)) {
    let text: string | null = null;
    try {
      text = readFileSync(join(at, ".howl", "howl.yml"), "utf8");
    } catch {
      // Not here; look further up.
    }
    if (text !== null) return read(at, text);
    if (dirname(at) === at) return null;
  }
}

function read(root: string, text: string): ClassSettings | null {
  const classes = readBlock(text);
  if (classes.length === 0) return null;
  const settings = topLevel(text);
  const header = settings.get("class_header");
  const headerIn = settings.get("class_header_in");
  const found: ClassSettings = {
    root,
    classes,
    headerIn: headerIn === undefined ? [] : typeof headerIn === "string" ? [headerIn] : headerIn,
  };
  if (typeof header === "string" && header !== "") found.header = header;
  return found;
}

/** The items of the `classes:` block: `- name: x`, then `paths: [a, b]` or `paths:` and `- a` lines. */
function readBlock(text: string): CodeClass[] {
  const classes: CodeClass[] = [];
  let inBlock = false;
  let current: CodeClass | null = null;
  let inPaths = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "");
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) {
      inBlock = /^classes:\s*$/.test(line);
      current = null;
      inPaths = false;
      continue;
    }
    if (!inBlock) continue;
    const key = /^\s+(-\s+)?([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (key) {
      if (key[1] !== undefined) {
        current = { name: "", paths: [] };
        classes.push(current);
      }
      inPaths = false;
      if (!current) continue;
      const value = key[3]!.trim();
      if (key[2] === "name") current.name = plain(value);
      else if (key[2] === "paths") {
        if (value.startsWith("[") && value.endsWith("]")) {
          current.paths = value
            .slice(1, -1)
            .split(",")
            .map(plain)
            .filter((v) => v !== "");
        } else if (value === "") inPaths = true;
        else current.paths = [plain(value)];
      }
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && inPaths && current) {
      const v = plain(item[1]!);
      if (v !== "") current.paths.push(v);
    }
  }
  return classes.filter((c) => c.name !== "");
}

/**
 * Whether a glob matches a path: `*` within a folder, `**` across folders, `?`
 * one character; a pattern with no `/` matches the file's name in any folder.
 */
export function matchesGlob(pattern: string, path: string): boolean {
  const target = pattern.includes("/") ? path : path.slice(path.lastIndexOf("/") + 1);
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`).test(target);
}

/** The name of the first class with a pattern that matches, or undefined. */
export function classByPath(classes: CodeClass[], path: string): string | undefined {
  return classes.find((c) => c.paths.some((p) => matchesGlob(p, path)))?.name;
}

/** A class name as compared: lower case, spaces and `_` as `-`. */
export function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function sameClass(a: string, b: string): boolean {
  return normalise(a) === normalise(b);
}

/** The first group of the first match in the first lines of `text`, or undefined. */
export function headerClass(text: string, pattern: RegExp): string | undefined {
  for (const line of text.split(/\r?\n/).slice(0, HEADER_LINES)) {
    const match = pattern.exec(line);
    if (match) return match[1] ?? match[0];
  }
  return undefined;
}

export interface FileClass {
  file: string;
  /** The class named by the paths. */
  path?: string;
  /** The class the header names, as written there. */
  header?: string;
  /** The class in force: the higher of the two. */
  class?: string;
}

export interface ClassReport {
  files: FileClass[];
  /** One line for each file that breaks a rule. */
  problems: string[];
  /** Files per class in force, in the order of the classes. */
  counts: Record<string, number>;
}

/** Every tracked file with its class, and what is wrong. Only reads. */
export function classify(settings: ClassSettings): ClassReport {
  const listed = git(settings.root, "ls-files", "-z");
  if (listed === null) throw new Error("git did not list the files: is this a git repository?");
  const names = listed.split("\0").filter((n) => n !== "");
  let pattern: RegExp | undefined;
  if (settings.header !== undefined) {
    try {
      pattern = new RegExp(settings.header);
    } catch {
      throw new Error(`class_header is not a regular expression: ${settings.header}`);
    }
  }
  const rank = (name: string) => settings.classes.findIndex((c) => sameClass(c.name, name));
  const files: FileClass[] = [];
  const problems: string[] = [];
  const counts: Record<string, number> = Object.fromEntries(settings.classes.map((c) => [c.name, 0]));
  for (const file of names) {
    if (!existsSync(join(settings.root, file))) continue;
    const entry: FileClass = { file };
    const byPath = classByPath(settings.classes, file);
    if (byPath !== undefined) entry.path = byPath;
    else problems.push(`${file}: no class by path`);
    if (pattern !== undefined && settings.headerIn.some((p) => matchesGlob(p, file))) {
      let text = "";
      try {
        text = readFileSync(join(settings.root, file), "utf8");
      } catch {
        // Unreadable: it has no header.
      }
      const header = headerClass(text, pattern);
      if (header === undefined) problems.push(`${file}: no class in the header`);
      else {
        entry.header = header;
        if (rank(header) < 0) problems.push(`${file}: the header names no class: ${header}`);
        else if (byPath !== undefined && !sameClass(header, byPath)) {
          problems.push(`${file}: the header says ${header}, the path says ${byPath}`);
        }
      }
    }
    // The higher class is the one earlier in the list.
    const ranks = [entry.path, entry.header].map((n) => (n === undefined ? -1 : rank(n))).filter((r) => r >= 0);
    if (ranks.length > 0) {
      entry.class = settings.classes[Math.min(...ranks)]!.name;
      counts[entry.class] = (counts[entry.class] ?? 0) + 1;
    }
    files.push(entry);
  }
  return { files, problems, counts };
}
