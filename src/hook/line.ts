// The hook line that needs no Node (#67): one `curl` that sends the coding
// agent's own hook JSON to `howl up`, which builds the event. It prints
// nothing, waits at most a second and always ends with 0.
// @code_class recording

/** The names a session may give its work, as the headers that carry them. */
export const HOOK_HEADERS = {
  HOWL_ACTOR: "X-Howl-Actor",
  HOWL_TASK: "X-Howl-Task",
  HOWL_CHANGE: "X-Howl-Change",
  HOWL_ROLE: "X-Howl-Role",
  HOWL_ROLE_PROMPT: "X-Howl-Role-Prompt",
  HOWL_HARNESS: "X-Howl-Harness",
  HOWL_HARNESS_REVISION: "X-Howl-Harness-Revision",
} as const;

/**
 * The command for the hooks of the coding agent's settings. `tokenFile` is the
 * lasting token of the project: a file that holds the header line itself, so
 * that `curl` reads it (`-H @file`) and the token never stands on a command
 * line, where every user of the machine could read it. It may hold `$HOME`.
 * The brackets keep the shell's own words (no `curl`, no such file) silent too.
 */
export function curlHookLine(options: { url: string; tokenFile: string }): string {
  const names = Object.entries(HOOK_HEADERS)
    .map(([variable, header]) => `-H "${header}: $${variable}"`)
    .join(" ");
  return (
    `( curl -s -o /dev/null -m 1 -X POST -H 'Content-Type: application/json' ` +
    `-H @"${options.tokenFile}" ${names} ` +
    `--data-binary @- ${options.url}/api/hook ) 2>/dev/null || true`
  );
}

/** The line a token file holds, and the token in such a line; null when it holds none. */
export function tokenLine(token: string): string {
  return `Authorization: Bearer ${token}\n`;
}

export function tokenOfLine(text: string): string | null {
  return /^Authorization: Bearer ([0-9a-f]{64})\s*$/.exec(text)?.[1] ?? null;
}
