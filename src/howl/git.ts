// What howl reads from git: never more than a few quick calls, and never a path on the machine.
// @code_class recording
import { spawnSync } from "node:child_process";

/** Runs git in `dir`. The output without its last line break, or null when git fails or is not there. */
export function git(dir: string, ...args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    timeout: 1000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * The files git tracks in `dir`, or null when git fails or is not there. Not
 * for the hook: the list of a large repository takes more than `git` allows.
 */
export function trackedFiles(dir: string): string[] | null {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.split("\0").filter((name) => name !== "") : null;
}

/** The URL of the remote `origin`, or null. */
export function originUrl(dir: string): string | null {
  return git(dir, "config", "--get", "remote.origin.url");
}

/** `owner/name` from the URL of a remote, or null. Never a path on the machine. */
export function repoName(url: string | null): string | null {
  if (!url || url.startsWith("/") || url.startsWith("file:")) return null;
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Runs git in `dir` for a longer answer than `git` allows, with no trimming. Null when git fails or is not there. */
function gitLong(dir: string, ...args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout : null;
}

/** The full name of a commit as git reads `name`, or null when it names none. */
export function commitOf(dir: string, name: string): string | null {
  return git(dir, "rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`);
}

/**
 * The files of a commit below `dir`, named from `dir` as `trackedFiles` names
 * them, each with the name git gives its content. Null when git fails.
 */
export function blobsAt(dir: string, commit: string): Map<string, string> | null {
  const listed = gitLong(dir, "ls-tree", "-r", "-z", commit);
  if (listed === null) return null;
  const blobs = new Map<string, string>();
  for (const entry of listed.split("\0")) {
    // <mode> <type> <name of the content>\t<path>
    const match = /^\S+ blob (\S+)\t(.+)$/s.exec(entry);
    if (match) blobs.set(match[2]!, match[1]!);
  }
  return blobs;
}

/** The text of each content named, read in one call to git. Null when git fails; a content git does not have is left out. */
export function textsOf(dir: string, names: string[]): Map<string, string> | null {
  const texts = new Map<string, string>();
  if (names.length === 0) return texts;
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: dir,
    input: `${names.join("\n")}\n`,
    timeout: 60_000,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const out = result.stdout as Buffer;
  // Each answer: `<name> <type> <size>\n<content>\n`, or `<name> missing\n`.
  for (let at = 0; at < out.length; ) {
    const end = out.indexOf(10, at);
    if (end < 0) break;
    const [name, , size] = out.toString("utf8", at, end).split(" ");
    if (size === undefined || !/^[0-9]+$/.test(size)) {
      at = end + 1;
      continue;
    }
    texts.set(name!, out.toString("utf8", end + 1, end + 1 + Number(size)));
    at = end + 1 + Number(size) + 1;
  }
  return texts;
}
