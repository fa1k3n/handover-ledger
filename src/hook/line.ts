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
} as const;

/**
 * The command for the hooks of the coding agent's settings. `tokenFile` is the
 * lasting token of the project, read at every call; it may hold `$HOME`.
 */
export function curlHookLine(options: { url: string; tokenFile: string }): string {
  const names = Object.entries(HOOK_HEADERS)
    .map(([variable, header]) => `-H "${header}: $${variable}"`)
    .join(" ");
  return (
    `curl -s -o /dev/null -m 1 -X POST -H 'Content-Type: application/json' ` +
    `-H "Authorization: Bearer $(cat "${options.tokenFile}" 2>/dev/null)" ${names} ` +
    `--data-binary @- ${options.url}/api/hook || true`
  );
}
