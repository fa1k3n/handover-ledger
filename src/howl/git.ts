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
