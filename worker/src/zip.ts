/**
 * A streaming zip writer, the small part of the format the account export needs.
 *
 * Entries are stored, not deflated: the bulk of an export is files and images
 * that are already compressed, and the JSON beside them is small. What matters
 * more is memory. A Worker has 128 MB, so nothing here is held whole: an entry's
 * bytes go straight to the response as they are read from R2.
 *
 * That is why every entry sets bit 3 ("data descriptor"). The CRC and the size
 * are not known until the last byte has gone by, and the local header has
 * already been sent by then, so they follow the data instead. Readers take the
 * sizes from the central directory at the end, as unzip and every file manager
 * do; only a reader that tries to stream a zip front to back cannot, and that
 * is a limit of the format, not of this writer.
 *
 * Not supported, and refused loudly rather than written wrong: more than 65,535
 * entries, and any entry or archive over 4 GiB (zip64).
 */

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

interface Done {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

/** MS-DOS date and time, which is what a zip header stores. Local time has no meaning here, so UTC. */
function dosStamp(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export class ZipWriter {
  private offset = 0;
  private readonly done: Done[] = [];
  private readonly stamp: { time: number; date: number };

  constructor(
    private readonly out: WritableStreamDefaultWriter<Uint8Array>,
    at = new Date(),
  ) {
    this.stamp = dosStamp(at);
  }

  private async put(chunk: Uint8Array) {
    this.offset += chunk.length;
    if (this.offset > MAX_SIZE) throw new Error("The export is too large for one zip file.");
    await this.out.write(chunk);
  }

  /** Add an entry whose bytes arrive as a stream, or all at once. */
  async add(name: string, body: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    if (this.done.length >= MAX_ENTRIES) throw new Error("The export has too many files for one zip file.");
    const nameBytes = enc.encode(name);
    const start = this.offset;

    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true); // version needed
    head.setUint16(6, 0x0808, true); // utf-8 names, data descriptor follows
    head.setUint16(8, 0, true); // stored
    head.setUint16(10, this.stamp.time, true);
    head.setUint16(12, this.stamp.date, true);
    head.setUint16(26, nameBytes.length, true);
    await this.put(new Uint8Array(head.buffer));
    await this.put(nameBytes);

    let crc = 0;
    let size = 0;
    const feed = async (chunk: Uint8Array) => {
      crc = crc32(chunk, crc);
      size += chunk.length;
      await this.put(chunk);
    };
    if (body instanceof Uint8Array) await feed(body);
    else {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) await feed(value);
      }
    }

    const tail = new DataView(new ArrayBuffer(16));
    tail.setUint32(0, 0x08074b50, true);
    tail.setUint32(4, crc, true);
    tail.setUint32(8, size, true);
    tail.setUint32(12, size, true);
    await this.put(new Uint8Array(tail.buffer));
    this.done.push({ name: nameBytes, crc, size, offset: start });
  }

  addText(name: string, text: string) {
    return this.add(name, enc.encode(text));
  }

  /** The central directory and the end record, then close the stream. */
  async finish(): Promise<void> {
    const dirStart = this.offset;
    for (const e of this.done) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014b50, true);
      h.setUint16(4, 0x031e, true); // made by: unix, spec 3.0
      h.setUint16(6, 20, true);
      h.setUint16(8, 0x0808, true);
      h.setUint16(10, 0, true);
      h.setUint16(12, this.stamp.time, true);
      h.setUint16(14, this.stamp.date, true);
      h.setUint32(16, e.crc, true);
      h.setUint32(20, e.size, true);
      h.setUint32(24, e.size, true);
      h.setUint16(28, e.name.length, true);
      h.setUint32(38, (0o100644 << 16) >>> 0, true); // a regular file, rw-r--r--
      h.setUint32(42, e.offset, true);
      await this.put(new Uint8Array(h.buffer));
      await this.put(e.name);
    }
    const dirSize = this.offset - dirStart;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.done.length, true);
    end.setUint16(10, this.done.length, true);
    end.setUint32(12, dirSize, true);
    end.setUint32(16, dirStart, true);
    await this.put(new Uint8Array(end.buffer));
    await this.out.close();
  }
}
