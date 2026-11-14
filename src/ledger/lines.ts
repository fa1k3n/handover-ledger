// The lines of a ledger file as bytes: what the chain, a checkpoint and a bundle hash.
// @code_class evidence

/** The whole lines of a file as bytes, without their line breaks. A last line with no line break is left out: it is half written. */
export function wholeLines(bytes: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      out.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  return out;
}
