/**
 * Writes small, real .rar files (stored, no compression) for tests against
 * the real 7-Zip: RAR5 in one file or split into `.partN.rar`, and RAR 4 split
 * the old way (`.rar`, `.r00`, …). Our own code, from RARLAB's published
 * format notes; nothing copied from any other project.
 */

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff);
  return b;
};

// ---------------------------------------------------------------- RAR5

function vint(n: number): Buffer {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

const SIG5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

/** A RAR5 block: CRC32, size, then the rest. `rest` starts with the header type. */
function block5(rest: Buffer): Buffer {
  const body = Buffer.concat([vint(rest.length), rest]);
  return Buffer.concat([u32(crc32(body)), body]);
}

function main5(volume: boolean, number: number): Buffer {
  const flags = (volume ? 0x01 : 0) | (number > 0 ? 0x02 : 0);
  return block5(Buffer.concat([vint(1), vint(0), vint(flags), ...(number > 0 ? [vint(number)] : [])]));
}

function end5(more: boolean): Buffer {
  return block5(Buffer.concat([vint(5), vint(0), vint(more ? 1 : 0)]));
}

function file5(name: string, part: Buffer, opts: { unpacked: number; crc: number; before: boolean; after: boolean; encrypted: boolean }): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  // A password record, as an encrypted file carries (contents not really encrypted: these are only ever listed).
  const extra = opts.encrypted ? (() => {
    const data = Buffer.concat([vint(0x01), vint(0), vint(0), Buffer.from([15]), Buffer.alloc(16, 1), Buffer.alloc(16, 2)]);
    return Buffer.concat([vint(data.length), data]);
  })() : Buffer.alloc(0);
  const headFlags = 0x02 | (extra.length ? 0x01 : 0) | (opts.before ? 0x08 : 0) | (opts.after ? 0x10 : 0);
  const rest = Buffer.concat([
    vint(2),
    vint(headFlags),
    ...(extra.length ? [vint(extra.length)] : []),
    vint(part.length),
    vint(0x04), // file flags: data CRC32 present
    vint(opts.unpacked),
    vint(0x20), // attributes
    u32(opts.crc),
    vint(0), // stored
    vint(0), // Windows
    vint(nameBytes.length),
    nameBytes,
    extra,
  ]);
  return Buffer.concat([block5(rest), part]);
}

/** A RAR5 archive of `files`. With `volumes` > 1, the (single) file is split across that many parts. */
export function rar5(files: { name: string; data: Buffer; encrypted?: boolean }[], volumes = 1): Buffer[] {
  if (volumes === 1) {
    return [Buffer.concat([SIG5, main5(false, 0), ...files.map((f) => file5(f.name, f.data, { unpacked: f.data.length, crc: crc32(f.data), before: false, after: false, encrypted: !!f.encrypted })), end5(false)])];
  }
  const [f] = files;
  if (!f || files.length !== 1) throw new Error('split archives hold one file here');
  const size = Math.ceil(f.data.length / volumes);
  return Array.from({ length: volumes }, (_, i) => {
    const part = f.data.subarray(i * size, (i + 1) * size);
    const last = i === volumes - 1;
    // Every part but the last carries its own CRC; the last carries the whole file's.
    return Buffer.concat([SIG5, main5(true, i), file5(f.name, part, { unpacked: f.data.length, crc: last ? crc32(f.data) : crc32(part), before: i > 0, after: !last, encrypted: false }), end5(!last)]);
  });
}

// ---------------------------------------------------------------- RAR 4

const SIG4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);

/** A RAR 4 block: the CRC (low 16 bits of CRC32) of everything after it. */
function block4(type: number, flags: number, fields: Buffer): Buffer {
  const rest = Buffer.concat([Buffer.from([type]), u16(flags), u16(7 + fields.length), fields]);
  return Buffer.concat([u16(crc32(rest) & 0xffff), rest]);
}

/** A RAR 4 archive holding one file split across `volumes` parts, named the old way (.rar, .r00, .r01…). */
export function rar4(file: { name: string; data: Buffer }, volumes = 1): Buffer[] {
  const size = Math.ceil(file.data.length / volumes);
  const nameBytes = Buffer.from(file.name, 'latin1');
  return Array.from({ length: volumes }, (_, i) => {
    const part = file.data.subarray(i * size, (i + 1) * size);
    const last = i === volumes - 1;
    const archFlags = (volumes > 1 ? 0x0001 : 0) | (i === 0 && volumes > 1 ? 0x0100 : 0);
    const main = block4(0x73, archFlags, Buffer.concat([u16(0), u32(0)]));
    const fileFlags = 0x8000 | (i > 0 ? 0x01 : 0) | (!last ? 0x02 : 0);
    const fields = Buffer.concat([
      u32(part.length),
      u32(file.data.length),
      Buffer.from([2]), // Windows
      u32(last ? crc32(file.data) : crc32(part)),
      u32(0x5a210000), // a DOS date in 2025
      Buffer.from([29, 0x30]), // version 2.9, stored
      u16(nameBytes.length),
      u32(0x20),
      nameBytes,
    ]);
    const head = block4(0x74, fileFlags, fields);
    const end = block4(0x7b, last ? 0 : 0x0001, Buffer.alloc(0));
    return Buffer.concat([SIG4, main, head, part, end]);
  });
}

/** The "video" inside the archives in test/fixtures/archives (made by `rar5` and `rar4` above). */
export const FIXTURE_VIDEO = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 13) % 251));
