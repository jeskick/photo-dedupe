import { Buffer } from "node:buffer";

export function box(type, content) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + content.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, content]);
}

function boxCode(code, content) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + content.length, 0);
  header.writeUInt32BE(code, 4);
  return Buffer.concat([header, content]);
}

export function buildExifTiff(dateText, subsec) {
  const date = Buffer.alloc(20);
  Buffer.from(dateText, "latin1").copy(date);
  const sub = subsec ? Buffer.from(`${subsec}\0`, "latin1") : null;
  const exifCount = sub ? 2 : 1;
  const exifIfd = 26;
  const afterIfd = exifIfd + 2 + exifCount * 12 + 4;
  const datePos = afterIfd;
  const subInline = !sub || sub.length <= 4;
  const size = sub && !subInline ? datePos + 20 + sub.length : datePos + 20;
  const tiff = Buffer.alloc(size);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8769, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(exifIfd, 18);
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(exifCount, exifIfd);
  const entry = exifIfd + 2;
  tiff.writeUInt16LE(0x9003, entry);
  tiff.writeUInt16LE(2, entry + 2);
  tiff.writeUInt32LE(20, entry + 4);
  tiff.writeUInt32LE(datePos, entry + 8);
  if (sub) {
    const second = entry + 12;
    tiff.writeUInt16LE(0x9291, second);
    tiff.writeUInt16LE(2, second + 2);
    tiff.writeUInt32LE(sub.length, second + 4);
    if (subInline) sub.copy(tiff, second + 8);
    else {
      tiff.writeUInt32LE(datePos + 20, second + 8);
      sub.copy(tiff, datePos + 20);
    }
  }
  tiff.writeUInt32LE(0, entry + exifCount * 12);
  date.copy(tiff, datePos);
  return tiff;
}

export function buildJpeg(dateText, subsec, payload) {
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), buildExifTiff(dateText, subsec)]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length + 2, 0);
  const extra = Buffer.from(payload);
  const sosLength = Buffer.alloc(2);
  sosLength.writeUInt16BE(extra.length + 2, 0);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    length,
    body,
    Buffer.from([0xff, 0xda]),
    sosLength,
    extra,
    Buffer.from([0xff, 0xd9]),
  ]);
}

export function buildMp4(iso) {
  const mvhd = Buffer.alloc(100);
  const seconds = Math.floor((Date.UTC(2019, 0, 1) - Date.UTC(1904, 0, 1)) / 1000);
  mvhd.writeUInt32BE(seconds >>> 0, 4);
  const keyName = Buffer.from("com.apple.quicktime.creationdate");
  const entry = Buffer.alloc(8 + keyName.length);
  entry.writeUInt32BE(entry.length, 0);
  entry.write("mdta", 4, "latin1");
  keyName.copy(entry, 8);
  const keysContent = Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
    entry,
  ]);
  const value = Buffer.from(iso);
  const dataContent = Buffer.alloc(8 + value.length);
  dataContent.writeUInt32BE(1, 0);
  value.copy(dataContent, 8);
  const meta = box("meta", Buffer.concat([
    Buffer.from([0, 0, 0, 0]),
    box("keys", keysContent),
    box("ilst", boxCode(1, box("data", dataContent))),
  ]));
  const moovBody = Buffer.concat([box("mvhd", mvhd), box("udta", meta)]);
  const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1"));
  const mdat = box("mdat", Buffer.alloc(80, 7));
  return {
    file: Buffer.concat([ftyp, mdat, box("moov", moovBody)]),
    moovBody,
  };
}

export function buildHeic(dateText, subsec) {
  const payload = Buffer.concat([Buffer.alloc(4), buildExifTiff(dateText, subsec)]);
  const infe = Buffer.from([
    0x00, 0x00, 0x00, 0x15,
    0x69, 0x6e, 0x66, 0x65,
    0x02, 0x00, 0x00, 0x00,
    0x00, 0x01,
    0x00, 0x00,
    0x45, 0x78, 0x69, 0x66,
    0x00,
  ]);
  const iinf = box("iinf", Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1]), infe]));
  const ftyp = box("ftyp", Buffer.from("heic\0\0\0\0heic", "latin1"));
  const ilocBoxLength = 8 + 22;
  const payloadOffset = ftyp.length + 8 + 4 + iinf.length + ilocBoxLength;
  const iloc = Buffer.alloc(22);
  iloc[4] = 0x44;
  iloc.writeUInt16BE(1, 6);
  iloc.writeUInt16BE(1, 8);
  iloc.writeUInt16BE(0, 10);
  iloc.writeUInt16BE(1, 12);
  iloc.writeUInt32BE(payloadOffset, 14);
  iloc.writeUInt32BE(payload.length, 18);
  const meta = box("meta", Buffer.concat([Buffer.alloc(4), iinf, box("iloc", iloc)]));
  if (ftyp.length + meta.length !== payloadOffset) {
    throw new Error(`HEIC 布局错误 ${ftyp.length + meta.length} != ${payloadOffset}`);
  }
  return Buffer.concat([ftyp, meta, payload]);
}

export function buildCr3(dateText, subsec) {
  const jpeg = buildJpeg(dateText, subsec, Buffer.from("preview-bytes"));
  const ftyp = box("ftyp", Buffer.from("crx \0\0\0\0crx ", "latin1"));
  return Buffer.concat([ftyp, box("moov", jpeg)]);
}
