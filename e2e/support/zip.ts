// A small zip reader for the export tests. It reads the central directory (as
// every real unzip tool does), supports stored and deflated entries, and checks
// each entry's CRC-32, so a corrupt archive fails here rather than in someone's
// file manager. Independent of the Worker's writer on purpose.
import { crc32, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export function readZip(buf: Buffer): Map<string, Buffer> {
  // End of central directory: last 22 bytes when there is no comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`unsupported method ${method} for ${name}`);
    if (data.length !== usize) throw new Error(`size mismatch for ${name}`);
    if (crc32(data) !== crc) throw new Error(`crc mismatch for ${name}`);
    if (out.has(name)) throw new Error(`duplicate entry ${name}`);
    out.set(name, data);
  }
  return out;
}

export const jsonEntry = <T = any>(zip: Map<string, Buffer>, name: string): T => {
  const data = zip.get(name);
  if (!data) throw new Error(`no ${name} in the archive (has: ${[...zip.keys()].join(", ")})`);
  return JSON.parse(data.toString("utf8")) as T;
};

/** Every text entry joined, for "this string appears nowhere in the archive". */
export const allText = (zip: Map<string, Buffer>): string =>
  [...zip.entries()].map(([n, d]) => `${n}\n${d.toString("latin1")}`).join("\n");
