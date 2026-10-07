import fs from "node:fs";
import { isVideoExt } from "./extensions.js";

const TYPE_LEN = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  9: 4,
  10: 8,
};

const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/;
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "udta", "edts"]);

export function parseWallClock(year, month, day, hour, minute, second, fractionDigits) {
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  if (y < 1980 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) {
    return null;
  }
  let ms = 0;
  let subsecKnown = false;
  if (fractionDigits && /\d/.test(fractionDigits)) {
    const digits = String(fractionDigits).replace(/\D/g, "").slice(0, 3);
    if (digits) {
      subsecKnown = true;
      ms = Number(digits.padEnd(3, "0").slice(0, 3));
    }
  }
  return { captureMs: Date.UTC(y, mo - 1, d, h, mi, s, ms), subsecKnown };
}

export function parseExifDate(text, subsec) {
  if (!text) return null;
  const match = EXIF_DATE.exec(String(text).trim());
  if (!match) return null;
  return parseWallClock(match[1], match[2], match[3], match[4], match[5], match[6], subsec);
}

export function parseIsoDate(text) {
  if (!text) return null;
  const match = ISO_DATE.exec(String(text).trim());
  if (!match) return null;
  return parseWallClock(match[1], match[2], match[3], match[4], match[5], match[6], match[7]);
}

function parseXmpDate(text) {
  if (!text) return null;
  const patterns = [
    /exif:DateTimeOriginal(?:>|=")(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)/,
    /xmp:CreateDate(?:>|=")(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)/,
    /photoshop:DateCreated(?:>|=")(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const parsed = parseIsoDate(match[1]);
    if (parsed) return { ...parsed, source: "xmp" };
  }
  return null;
}

function chooseExif(dates, subs) {
  const tag = dates[0x9003] ? 0x9003 : dates[0x9004] ? 0x9004 : dates[0x0132] ? 0x0132 : 0;
  if (!tag) return null;
  const subTag = tag === 0x9003 ? 0x9291 : tag === 0x9004 ? 0x9292 : 0x9290;
  const parsed = parseExifDate(dates[tag], subs[subTag]);
  return parsed ? { ...parsed, source: "exif" } : null;
}

/** 从 TIFF / EXIF 字节里只取拍摄时间，不展开厂商私有数据。 */
export function parseTiffCapture(tiff) {
  if (!tiff || tiff.length < 8) return null;
  const endian = tiff.toString("latin1", 0, 2);
  const le = endian === "II";
  if (!le && endian !== "MM") return null;
  const u16 = (offset) => {
    if (offset < 0 || offset + 2 > tiff.length) return null;
    return le ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
  };
  const u32 = (offset) => {
    if (offset < 0 || offset + 4 > tiff.length) return null;
    return le ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
  };
  if (u16(2) !== 42) return null;
  const ifd0 = u32(4);
  if (ifd0 == null) return null;

  let need = 0;
  const dates = {};
  const subs = {};
  const seen = new Set();
  const markNeed = (n) => {
    if (n > tiff.length && n > need) need = n;
  };

  const walk = (offset, depth) => {
    if (offset == null || depth > 4 || seen.has(offset)) return;
    if (offset + 2 > tiff.length) {
      markNeed(offset + 2);
      return;
    }
    seen.add(offset);
    const count = u16(offset);
    if (count == null || count > 512) return;
    const bytes = 2 + count * 12 + 4;
    if (offset + bytes > tiff.length) {
      markNeed(offset + bytes);
      return;
    }
    for (let i = 0; i < count; i += 1) {
      const entry = offset + 2 + i * 12;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const cnt = u32(entry + 4);
      if (tag == null || type == null || cnt == null) return;
      const typeLen = TYPE_LEN[type] || 0;
      if (!typeLen || cnt > 2_000_000) continue;
      const total = typeLen * cnt;
      let valPos = entry + 8;
      if (total > 4) {
        const ptr = u32(entry + 8);
        if (ptr == null) return;
        valPos = ptr;
      }
      if (tag === 0x8769 && (type === 4 || type === 3) && cnt >= 1) {
        const sub = type === 4 ? u32(entry + 8) : u16(entry + 8);
        if (sub) walk(sub, depth + 1);
      }
      const isDate = tag === 0x9003 || tag === 0x9004 || tag === 0x0132;
      const isSub = tag === 0x9291 || tag === 0x9292 || tag === 0x9290;
      if ((isDate || isSub) && type === 2 && valPos + Math.min(total, 4) > tiff.length) {
        markNeed(valPos + total);
        continue;
      }
      if (isDate && type === 2 && cnt >= 19 && valPos + 19 <= tiff.length) {
        dates[tag] = tiff.toString("latin1", valPos, valPos + Math.min(cnt, 32)).replace(/\0.*$/s, "");
      }
      if (isSub && type === 2 && cnt > 0 && cnt < 16 && valPos + Math.min(cnt, 8) <= tiff.length) {
        const take = Math.min(cnt, tiff.length - valPos);
        subs[tag] = tiff.toString("latin1", valPos, valPos + take).replace(/\0.*$/s, "");
      }
    }
  };

  walk(ifd0, 0);
  const chosen = chooseExif(dates, subs);
  if (chosen) return chosen;
  if (need > tiff.length) return { need };
  return null;
}

function parseJpegBuffer(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  let xmp = null;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return xmp ? parseXmpDate(xmp) : null;
    let marker = buf[offset + 1];
    while (marker === 0xff && offset + 2 < buf.length) {
      offset += 1;
      marker = buf[offset + 1];
    }
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buf.length) return { need: offset + 65535 };
    const segLen = buf.readUInt16BE(offset);
    if (segLen < 2) return null;
    const segEnd = offset + segLen;
    if (segEnd > buf.length) return { need: segEnd + 2 };
    if (marker === 0xe1) {
      const body = buf.subarray(offset + 2, segEnd);
      if (body.length >= 6 && body.toString("latin1", 0, 6) === "Exif\0\0") {
        const tiff = parseTiffCapture(body.subarray(6));
        if (tiff?.captureMs != null) return tiff;
        if (tiff?.need) return { need: offset + 8 + tiff.need };
      } else if (!xmp && body.toString("latin1", 0, 28).startsWith("http://ns.adobe.com/xap")) {
        xmp = body.toString("utf8");
      }
    }
    offset = segEnd;
  }
  return xmp ? parseXmpDate(xmp) : null;
}

function forEachBox(buf, start, end, visitor) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const typeCode = buf.readUInt32BE(offset + 4);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = Number(buf.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isFinite(size) || size < headerSize || offset + size > end) return;
    const stop = visitor({
      type,
      typeCode,
      start: offset,
      headerSize,
      contentStart: offset + headerSize,
      end: offset + size,
    });
    if (stop) return;
    offset += size;
  }
}

function readMvhd(buf, contentStart) {
  if (contentStart + 8 > buf.length) return null;
  const version = buf[contentStart];
  let seconds;
  if (version === 0) {
    if (contentStart + 8 > buf.length) return null;
    seconds = buf.readUInt32BE(contentStart + 4);
  } else if (version === 1) {
    if (contentStart + 12 > buf.length) return null;
    seconds = Number(buf.readBigUInt64BE(contentStart + 4));
  } else {
    return null;
  }
  const mac = Date.UTC(1904, 0, 1) / 1000;
  const captureMs = (seconds + mac) * 1000;
  if (!Number.isFinite(captureMs)) return null;
  const check = new Date(captureMs);
  const year = check.getUTCFullYear();
  if (year < 1980 || year > 2100) return null;
  return { captureMs, subsecKnown: false, source: "mvhd" };
}

function parseKeysBox(buf, start, end) {
  if (end - start < 8) return [];
  const count = buf.readUInt32BE(start + 4);
  if (count > 400) return [];
  const keys = [];
  let offset = start + 8;
  for (let i = 0; i < count && offset + 8 <= end; i += 1) {
    const size = buf.readUInt32BE(offset);
    if (size < 8 || offset + size > end) break;
    keys.push(buf.toString("utf8", offset + 8, offset + size).replace(/\0/g, ""));
    offset += size;
  }
  return keys;
}

function parseIlstValue(buf, start, end) {
  let found = null;
  forEachBox(buf, start, end, (box) => {
    if (box.type !== "data" || box.contentStart + 8 > box.end) return;
    const dataType = buf.readUInt32BE(box.contentStart);
    if (dataType !== 1) return;
    found = buf.toString("utf8", box.contentStart + 8, box.end).replace(/\0/g, "").trim();
    return true;
  });
  return found;
}

function parseQuickTimeMeta(buf, metaContentStart, metaEnd) {
  const childStart = metaContentStart + 4;
  if (childStart >= metaEnd) return null;
  let keys = null;
  const values = new Map();
  forEachBox(buf, childStart, metaEnd, (box) => {
    if (box.type === "keys") keys = parseKeysBox(buf, box.contentStart, box.end);
    if (box.type === "ilst") {
      forEachBox(buf, box.contentStart, box.end, (item) => {
        const value = parseIlstValue(buf, item.contentStart, item.end);
        if (value) values.set(item.typeCode, value);
      });
    }
  });
  if (!keys) return null;
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] === "com.apple.quicktime.creationdate") {
      const parsed = parseIsoDate(values.get(i + 1));
      if (parsed) return { ...parsed, source: "quicktime" };
    }
  }
  return null;
}

export function parseMoovBuffer(buf) {
  let quicktime = null;
  let mvhd = null;
  const visit = (start, end, depth) => {
    forEachBox(buf, start, end, (box) => {
      if (box.type === "mvhd" && !mvhd) mvhd = readMvhd(buf, box.contentStart);
      if (box.type === "meta") {
        const found = parseQuickTimeMeta(buf, box.contentStart, box.end);
        if (found) quicktime = found;
      }
      if (!quicktime && CONTAINERS.has(box.type) && depth < 6) {
        visit(box.contentStart, box.end, depth + 1);
      }
    });
  };
  visit(0, buf.length, 0);
  return quicktime || mvhd;
}

function readN(buf, offset, size) {
  if (size <= 0) return 0;
  if (offset + size > buf.length || size > 8) return null;
  let value = 0n;
  for (let i = 0; i < size; i += 1) value = (value << 8n) + BigInt(buf[offset + i]);
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) return null;
  return asNumber;
}

export function parseIloc(data) {
  if (!data || data.length < 8) return [];
  const version = data[0];
  const offsetSize = data[4] >> 4;
  const lengthSize = data[4] & 0x0f;
  const baseOffsetSize = data[5] >> 4;
  const indexSize = version === 1 || version === 2 ? data[5] & 0x0f : 0;
  let offset = 6;
  let itemCount;
  if (version < 2) {
    if (offset + 2 > data.length) return [];
    itemCount = data.readUInt16BE(offset);
    offset += 2;
  } else {
    if (offset + 4 > data.length) return [];
    itemCount = data.readUInt32BE(offset);
    offset += 4;
  }
  if (itemCount > 64) return [];
  const items = [];
  for (let i = 0; i < itemCount; i += 1) {
    let itemId;
    if (version < 2) {
      if (offset + 2 > data.length) break;
      itemId = data.readUInt16BE(offset);
      offset += 2;
    } else {
      if (offset + 4 > data.length) break;
      itemId = data.readUInt32BE(offset);
      offset += 4;
    }
    let method = 0;
    if (version === 1 || version === 2) {
      if (offset + 2 > data.length) break;
      method = data.readUInt16BE(offset) & 0x0f;
      offset += 2;
    }
    if (offset + 2 > data.length) break;
    offset += 2;
    const base = readN(data, offset, baseOffsetSize);
    if (base == null) break;
    offset += baseOffsetSize;
    if (offset + 2 > data.length) break;
    const extentCount = data.readUInt16BE(offset);
    offset += 2;
    if (extentCount > 8) break;
    const extents = [];
    for (let j = 0; j < extentCount; j += 1) {
      if (indexSize) offset += indexSize;
      const extOff = readN(data, offset, offsetSize);
      offset += offsetSize;
      const extLen = readN(data, offset, lengthSize);
      offset += lengthSize;
      if (extOff == null || extLen == null) return items;
      extents.push({ offset: base + extOff, length: extLen, method });
    }
    items.push({ itemId, extents });
  }
  return items;
}

export function parseIinf(data) {
  if (!data || data.length < 6) return [];
  const version = data[0];
  let offset = 4;
  if (offset + 2 > data.length) return [];
  const entryCount = data.readUInt16BE(offset);
  offset += 2;
  if (entryCount > 64) return [];
  const items = [];
  for (let i = 0; i < entryCount && offset + 16 <= data.length; i += 1) {
    const size = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    if (type !== "infe" || size < 16 || offset + size > data.length) break;
    const ver = data[offset + 8];
    let cursor = offset + 12;
    let itemId = 0;
    let itemType = "";
    if (ver === 0 || ver === 1) {
      if (cursor + 4 <= offset + size) itemId = data.readUInt16BE(cursor);
    } else if (cursor + 8 <= offset + size) {
      if (ver === 2) {
        itemId = data.readUInt16BE(cursor);
        cursor += 2;
      } else {
        itemId = data.readUInt32BE(cursor);
        cursor += 4;
      }
      cursor += 2;
      if (cursor + 4 <= offset + size) itemType = data.toString("latin1", cursor, cursor + 4);
    }
    items.push({ itemId, itemType });
    offset += size;
    if (version === 0 && ver >= 2) {
      /* 继续按盒子长度前进 */
    }
  }
  return items;
}

function tiffFromExifPayload(payload) {
  if (!payload || payload.length < 16) return null;
  const prefix = payload.readUInt32BE(0);
  const candidates = [4 + prefix, prefix, 0];
  for (const start of candidates) {
    if (start < 0 || start + 8 > payload.length) continue;
    const parsed = parseTiffCapture(payload.subarray(start));
    if (parsed?.captureMs != null) return parsed;
  }
  const marker = payload.indexOf("Exif\0\0");
  if (marker >= 0 && marker + 14 < payload.length) {
    const parsed = parseTiffCapture(payload.subarray(marker + 6));
    if (parsed?.captureMs != null) return parsed;
  }
  return null;
}

function findEmbeddedCapture(buf) {
  if (!buf || buf.length < 16) return null;
  const jpegAt = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  if (jpegAt >= 0) {
    const parsed = parseJpegBuffer(buf.subarray(jpegAt));
    if (parsed?.captureMs != null) return parsed;
  }
  let from = 0;
  const magics = [Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.from([0x4d, 0x4d, 0x00, 0x2a])];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let at = -1;
    for (const magic of magics) {
      const found = buf.indexOf(magic, from);
      if (found >= 0 && (at < 0 || found < at)) at = found;
    }
    if (at < 0) break;
    const parsed = parseTiffCapture(buf.subarray(at));
    if (parsed?.captureMs != null) return parsed;
    from = at + 4;
  }
  const xmp = parseXmpDate(buf.toString("latin1"));
  return xmp;
}

class FileReader {
  constructor(filePath) {
    this.fh = fs.openSync(filePath, "r");
    this.bytesRead = 0;
  }

  read(pos, len) {
    if (len <= 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(this.fh, buf, got, len - got, pos + got);
      if (n <= 0) break;
      got += n;
    }
    this.bytesRead += got;
    return got === len ? buf : buf.subarray(0, got);
  }

  close() {
    fs.closeSync(this.fh);
  }
}

function readHeader(reader, pos, limit) {
  if (pos + 8 > limit) return null;
  const buf = reader.read(pos, Math.min(16, limit - pos));
  if (buf.length < 8) return null;
  let size = buf.readUInt32BE(0);
  const type = buf.toString("latin1", 4, 8);
  let headerSize = 8;
  if (size === 1) {
    if (buf.length < 16) return null;
    size = Number(buf.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) {
    size = limit - pos;
  }
  if (!Number.isFinite(size) || size < headerSize || pos + size > limit) return null;
  return { pos, size, headerSize, type, contentPos: pos + headerSize, contentEnd: pos + size };
}

function walkFileBoxes(reader, start, end, visitor) {
  let pos = start;
  while (pos + 8 <= end) {
    const box = readHeader(reader, pos, end);
    if (!box) return;
    const stop = visitor(box);
    if (stop) return;
    pos = box.pos + box.size;
  }
}

function captureFromStillPrefix(reader, fileSize) {
  const first = Math.min(fileSize, 256 * 1024);
  let buf = reader.read(0, first);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    let parsed = parseJpegBuffer(buf);
    if (parsed?.need && parsed.need > buf.length && parsed.need <= Math.min(fileSize, 8 * 1024 * 1024)) {
      buf = reader.read(0, parsed.need);
      parsed = parseJpegBuffer(buf);
    }
    if (parsed?.captureMs != null) return parsed;
  }
  const endian = buf.toString("latin1", 0, 2);
  if (endian === "II" || endian === "MM") {
    let parsed = parseTiffCapture(buf);
    if (parsed?.need && parsed.need > buf.length && parsed.need <= Math.min(fileSize, 8 * 1024 * 1024)) {
      buf = reader.read(0, parsed.need);
      parsed = parseTiffCapture(buf);
    }
    if (parsed?.captureMs != null) return parsed;
  }
  if (buf.toString("latin1", 0, 8) === "FUJIFILM") {
    const raf = reader.read(0, Math.min(fileSize, 4 * 1024 * 1024));
    const found = findEmbeddedCapture(raf);
    if (found?.captureMs != null) return found;
  }
  return null;
}

function captureFromBmff(reader, fileSize) {
  const head = reader.read(0, Math.min(fileSize, 12));
  if (head.length < 12 || head.toString("latin1", 4, 8) !== "ftyp") return null;
  let found = null;
  walkFileBoxes(reader, 0, fileSize, (box) => {
    if (found) return true;
    if (box.type === "meta" && box.size <= 8 * 1024 * 1024) {
      const meta = reader.read(box.pos, box.size);
      let iinf = null;
      let ilocBuf = null;
      forEachBox(meta, box.headerSize + 4, meta.length, (child) => {
        if (child.type === "iinf") iinf = meta.subarray(child.contentStart, child.end);
        if (child.type === "iloc") ilocBuf = meta.subarray(child.contentStart, child.end);
      });
      const exifIds = new Set(
        parseIinf(iinf || Buffer.alloc(0)).filter((item) => item.itemType === "Exif").map((item) => item.itemId),
      );
      if (exifIds.size) {
        const locations = parseIloc(ilocBuf || Buffer.alloc(0));
        for (const loc of locations) {
          if (!exifIds.has(loc.itemId)) continue;
          for (const extent of loc.extents) {
            if (extent.method !== 0 || extent.length <= 0 || extent.length > 2 * 1024 * 1024) continue;
            if (extent.offset + extent.length > fileSize) continue;
            const payload = reader.read(extent.offset, extent.length);
            const parsed = tiffFromExifPayload(payload);
            if (parsed?.captureMs != null) {
              found = parsed;
              return true;
            }
          }
        }
      }
    }
    if (box.type === "moov" && box.size <= 16 * 1024 * 1024) {
      const moov = reader.read(box.contentPos, box.size - box.headerSize);
      const qt = parseMoovBuffer(moov);
      if (qt?.captureMs != null) {
        found = qt;
        return true;
      }
      const embedded = findEmbeddedCapture(moov);
      if (embedded?.captureMs != null) {
        found = embedded;
        return true;
      }
    }
    return false;
  });
  return found;
}

function captureFromVideo(reader, fileSize) {
  let mvhd = null;
  let quicktime = null;
  const considerUdta = (udta) => {
    if (quicktime || udta.size > 6 * 1024 * 1024) return;
    const buf = reader.read(udta.contentPos, udta.size - udta.headerSize);
    walkMemory(buf, 0, buf.length, (box) => {
      if (box.type === "meta" && !quicktime) {
        const parsed = parseQuickTimeMeta(buf, box.contentStart, box.end);
        if (parsed) quicktime = parsed;
      }
    });
    if (!quicktime) {
      const text = buf.toString("latin1");
      const at = text.indexOf("com.apple.quicktime.creationdate");
      if (at >= 0) {
        const window = buf.subarray(at, Math.min(buf.length, at + 512)).toString("latin1");
        const parsed = parseIsoDate(window.slice(window.indexOf("2")));
        if (parsed) quicktime = { ...parsed, source: "quicktime" };
      }
    }
  };
  const walkMoov = (moov) => {
    walkFileBoxes(reader, moov.contentPos, moov.contentEnd, (child) => {
      if (child.type === "mvhd" && !mvhd) {
        const buf = reader.read(child.contentPos, Math.min(120, child.size - child.headerSize));
        mvhd = readMvhd(buf, 0);
      } else if (child.type === "udta") {
        considerUdta(child);
      }
      return Boolean(quicktime && mvhd);
    });
  };
  walkFileBoxes(reader, 0, fileSize, (box) => {
    if (box.type === "moov") walkMoov(box);
    return Boolean(quicktime);
  });
  return quicktime || mvhd;
}

function walkMemory(buf, start, end, visitor) {
  forEachBox(buf, start, end, visitor);
}

export function readCapture(filePath, ext, fileSize) {
  const reader = new FileReader(filePath);
  try {
    const video = isVideoExt(ext);
    const parsed = video ? captureFromVideo(reader, fileSize) : captureFromStillPrefix(reader, fileSize) || captureFromBmff(reader, fileSize);
    return {
      capture: parsed?.captureMs != null ? parsed : null,
      bytesRead: reader.bytesRead,
    };
  } catch {
    return { capture: null, bytesRead: reader.bytesRead };
  } finally {
    reader.close();
  }
}

export function sourceLabel(source) {
  if (source === "exif") return "EXIF";
  if (source === "xmp") return "XMP";
  if (source === "quicktime") return "视频拍摄时间";
  if (source === "mvhd") return "视频创建时间";
  return "无拍摄时间";
}
