// A minimal ustar writer and reader for evidence bundles (#19): regular files only,
// fixed times and modes, so the same files always give the same bytes. gzip on top.
// @code_class evidence
import { gunzipSync, gzipSync } from "node:zlib";
import { LedgerError } from "../ledger/errors.ts";
import { byUnits } from "../read/order.ts";

const BLOCK = 512;

function header(name: string, size: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new LedgerError(`${name}: a name in a bundle has at most 100 bytes`);
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii");
  h.write("0000000\0", 116, 8, "ascii");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  h.write("00000000000\0", 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write("0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

/** The files as a tar archive, gzipped when asked. */
export function writeTar(files: Map<string, Buffer>, gzip = false): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of [...files.entries()].sort((a, b) => byUnits(a[0], b[0]))) {
    parts.push(header(name, data.length), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  const tar = Buffer.concat(parts);
  return gzip ? gzipSync(tar, { level: 9 }) : tar;
}

/** The files of a tar archive, gzipped or not. */
export function readTar(bytes: Buffer): Map<string, Buffer> {
  const tar = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  const files = new Map<string, Buffer>();
  for (let at = 0; at + BLOCK <= tar.length; ) {
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(h.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim() || "0", 8);
    if (!name || Number.isNaN(size)) throw new LedgerError("the bundle is not a tar archive howl can read");
    at += BLOCK;
    files.set(name, Buffer.from(tar.subarray(at, at + size)));
    at += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
