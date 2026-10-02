import zlib from 'node:zlib';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';

/**
 * Streaming ZIP writer, no dependency: « stored » entries (MP3/Opus/AAC are already compressed),
 * sizes and CRC-32 sent after the data (general purpose bit 3 + data descriptor), UTF-8 names (bit 11),
 * central directory at the end. ZIP32 only: the whole archive stays under 4 GiB (`limit`).
 */
const FLAGS = 0x0808;
export const ZIP32_LIMIT = 0xffffffff - 16 * 1024 * 1024; // room left for the central directory and the report

function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipWriter {
  constructor({ limit = ZIP32_LIMIT, signal } = {}) {
    this.stream = new PassThrough();
    this.limit = limit;
    this.signal = signal;
    this.offset = 0;
    this.entries = [];
    this.stamp = dosTime();
  }

  async write(buf) {
    this.offset += buf.length;
    if (!this.stream.write(buf)) await once(this.stream, 'drain', { signal: this.signal });
  }

  /**
   * Copy `source` (async iterable of Buffers) as one entry. Nothing is written until the first byte arrives,
   * so a source that fails before producing anything leaves no trace. Returns { size, truncated }:
   * `truncated` when the archive limit was reached (the entry is closed with what was copied).
   * `capped: false` (small report at the end) may use the margin kept below 4 GiB.
   */
  async add(name, source, { capped = true } = {}) {
    const nameBuf = Buffer.from(name, 'utf8');
    let crc = 0;
    let size = 0;
    let start = -1;
    let truncated = false;
    for await (const chunk of source) {
      if (start < 0) {
        start = this.offset;
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(FLAGS, 6);
        h.writeUInt16LE(0, 8); // stored
        h.writeUInt16LE(this.stamp.time, 10);
        h.writeUInt16LE(this.stamp.date, 12);
        h.writeUInt16LE(nameBuf.length, 26); // crc and sizes stay 0: they follow in the data descriptor
        await this.write(Buffer.concat([h, nameBuf]));
      }
      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = this.limit - this.offset - 16;
      if (capped && buf.length > room) { buf = buf.subarray(0, Math.max(0, room)); truncated = true; }
      crc = zlib.crc32(buf, crc);
      size += buf.length;
      await this.write(buf);
      if (truncated) break;
    }
    if (start < 0) return { size: 0, truncated: false };
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    d.writeUInt32LE(size, 8);
    d.writeUInt32LE(size, 12);
    await this.write(d);
    this.entries.push({ nameBuf, crc: crc >>> 0, size, start });
    return { size, truncated };
  }

  get full() { return this.offset + 1024 >= this.limit; }

  /** Central directory + end record, then end of stream. */
  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(FLAGS, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(this.stamp.time, 12);
      c.writeUInt16LE(this.stamp.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.size, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt32LE(e.start, 42);
      await this.write(Buffer.concat([c, e.nameBuf]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    await this.write(end);
    this.stream.end();
  }
}
