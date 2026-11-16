// A review round in words, for `howl show` and the dashboard: the same reviewer and outcome in a row folds into one entry with a count. No Node, so the page can use it.
// @code_class reading

export interface RoundReview {
  actor?: { id: string };
  outcome: string;
  /** The agent behind a person's account, when one matches (#14). */
  by?: string;
  /** #45: the review was dismissed, when and by whom. */
  dismissed?: { time: string; actor?: { id: string } };
}

/** `agent-1 via person-aaaa commented ×16, bob approved`. */
export function roundText(reviews: RoundReview[], time?: (t: string) => string): string {
  const who = (x: RoundReview) => (x.by ? `${x.by} via ${x.actor?.id ?? "someone"}` : (x.actor?.id ?? "someone"));
  const parts: { text: string; n: number }[] = [];
  for (const x of reviews) {
    const dismissed = x.dismissed === undefined ? "" : ` (dismissed by ${x.dismissed.actor?.id ?? "someone"}${time ? ` at ${time(x.dismissed.time)}` : ""})`;
    const text = `${who(x)} ${x.outcome.replace("_", " ")}${dismissed}`;
    const last = parts.at(-1);
    // #48: reviews with no actor (accounts that are gone) are not one reviewer, so they stay apart.
    if (last && last.text === text && x.actor !== undefined) last.n++;
    else parts.push({ text, n: 1 });
  }
  return parts.map((p) => (p.n > 1 ? `${p.text} ×${p.n}` : p.text)).join(", ");
}
