import fs from "node:fs";

const TYPE_LEN = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
const PROGRAM = {
  1: "手动",
  2: "程序自动",
  3: "光圈优先",
  4: "快门优先",
  5: "创意程序",
  6: "运动模式",
  7: "人像",
  8: "风景",
};
const METER = {
  1: "平均",
  2: "中央重点",
  3: "点测光",
  4: "多点",
  5: "多区域",
  6: "局部",
};

function trimNum(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatBytes(size) {
  const n = Number(size) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatShutter(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds >= 1) return `${trimNum(seconds)} 秒`;
  return `1/${Math.max(1, Math.round(1 / seconds))} 秒`;
}

function prettyTime(text) {
  return String(text || "").replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").trim();
}

function formatGps(facts) {
  if (facts.latitude == null || facts.longitude == null) return "";
  const lat = `${Math.abs(facts.latitude).toFixed(5)}°${facts.latitude >= 0 ? "N" : "S"}`;
  const lng = `${Math.abs(facts.longitude).toFixed(5)}°${facts.longitude >= 0 ? "E" : "W"}`;
  return `${lat}  ${lng}`;
}

export function parseTiffFacts(tiff) {
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
  const i32 = (offset) => {
    if (offset < 0 || offset + 4 > tiff.length) return null;
    return le ? tiff.readInt32LE(offset) : tiff.readInt32BE(offset);
  };
  if (u16(2) !== 42) return null;
  const facts = {};
  const seen = new Set();
  const ascii = (pos, count) => {
    if (pos == null || count <= 0 || count > 400 || pos < 0 || pos + count > tiff.length) return "";
    return tiff.toString("utf8", pos, pos + count).replace(/\0.*$/s, "").trim();
  };
  const rational = (pos) => {
    const num = u32(pos);
    const den = u32(pos + 4);
    if (num == null || !den) return null;
    return num / den;
  };
  const srational = (pos) => {
    const num = i32(pos);
    const den = i32(pos + 4);
    if (num == null || !den) return null;
    return num / den;
  };
  const valuePos = (entry, type, count) => {
    const len = TYPE_LEN[type] || 0;
    if (!len || count <= 0) return null;
    const total = len * count;
    if (total <= 4) return entry + 8;
    return u32(entry + 8);
  };
  const take = (tag, type, count, pos) => {
    if (pos == null) return;
    if (tag === 0x010f) facts.make = ascii(pos, count);
    else if (tag === 0x0110) facts.model = ascii(pos, count);
    else if (tag === 0x010e) facts.description = ascii(pos, count);
    else if (tag === 0x0131) facts.software = ascii(pos, count);
    else if (tag === 0x013b) facts.artist = ascii(pos, count);
    else if (tag === 0x8298) facts.copyright = ascii(pos, count);
    else if (tag === 0xa434) facts.lens = ascii(pos, count);
    else if ((tag === 0x9003 || tag === 0x0132) && !facts.time) facts.time = ascii(pos, count);
    else if (tag === 0x829a) facts.exposure = rational(pos);
    else if (tag === 0x829d) facts.aperture = rational(pos);
    else if (tag === 0x920a) facts.focal = rational(pos);
    else if (tag === 0x9204) facts.bias = srational(pos);
    else if (tag === 0x8827 && type === 3) facts.iso = u16(pos);
    else if (tag === 0x8822 && type === 3) facts.program = u16(pos);
    else if (tag === 0x9207 && type === 3) facts.metering = u16(pos);
    else if (tag === 0x9209 && type === 3) facts.flash = u16(pos);
    else if (tag === 0xa403 && type === 3) facts.whiteBalance = u16(pos);
    else if (tag === 0xa405 && (type === 3 || type === 4)) facts.focal35 = type === 3 ? u16(pos) : u32(pos);
    else if ((tag === 0xa002 || tag === 0x0100) && (type === 3 || type === 4)) facts.width = type === 3 ? u16(pos) : u32(pos);
    else if ((tag === 0xa003 || tag === 0x0101) && (type === 3 || type === 4)) facts.height = type === 3 ? u16(pos) : u32(pos);
    else if (tag === 0x0002 && type === 5 && count >= 3) {
      const d = rational(pos);
      const m = rational(pos + 8);
      const s = rational(pos + 16);
      if (d != null && m != null && s != null) facts.latParts = d + m / 60 + s / 3600;
    } else if (tag === 0x0004 && type === 5 && count >= 3) {
      const d = rational(pos);
      const m = rational(pos + 8);
      const s = rational(pos + 16);
      if (d != null && m != null && s != null) facts.lngParts = d + m / 60 + s / 3600;
    } else if (tag === 0x0001) facts.latRef = ascii(pos, count);
    else if (tag === 0x0003) facts.lngRef = ascii(pos, count);
  };
  const walk = (offset, depth) => {
    if (offset == null || depth > 6 || seen.has(offset) || offset + 2 > tiff.length) return;
    seen.add(offset);
    const count = u16(offset);
    if (count == null || count <= 0 || count > 400) return;
    if (offset + 2 + count * 12 + 4 > tiff.length) return;
    for (let i = 0; i < count; i += 1) {
      const entry = offset + 2 + i * 12;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const cnt = u32(entry + 4);
      if (tag == null || type == null || cnt == null) continue;
      if (tag === 0x8769 || tag === 0x8825) {
        const ptr = type === 4 ? u32(entry + 8) : u16(entry + 8);
        if (ptr) walk(ptr, depth + 1);
        continue;
      }
      take(tag, type, cnt, valuePos(entry, type, cnt));
    }
  };
  walk(u32(4), 0);
  if (facts.latParts != null) facts.latitude = facts.latRef === "S" ? -facts.latParts : facts.latParts;
  if (facts.lngParts != null) facts.longitude = facts.lngRef === "W" ? -facts.lngParts : facts.lngParts;
  return facts;
}

function jpegSize(buf) {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    let marker = buf[offset + 1];
    while (marker === 0xff && offset + 2 < buf.length) {
      offset += 1;
      marker = buf[offset + 1];
    }
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buf.length) return null;
    const len = buf.readUInt16BE(offset);
    if (len < 2 || offset + len > buf.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcf && marker !== 0xcc)) {
      return { height: buf.readUInt16BE(offset + 3), width: buf.readUInt16BE(offset + 5) };
    }
    offset += len;
  }
  return null;
}

function factsFromJpeg(buf) {
  let facts = null;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) break;
    let marker = buf[offset + 1];
    while (marker === 0xff && offset + 2 < buf.length) {
      offset += 1;
      marker = buf[offset + 1];
    }
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buf.length) break;
    const len = buf.readUInt16BE(offset);
    if (len < 2 || offset + len > buf.length) break;
    if (marker === 0xe1) {
      const body = buf.subarray(offset + 2, offset + len);
      if (body.length >= 6 && body.toString("latin1", 0, 6) === "Exif\0\0") {
        facts = parseTiffFacts(body.subarray(6)) || facts;
      }
    }
    offset += len;
  }
  const size = jpegSize(buf);
  facts = facts || {};
  if (size && !facts.width) {
    facts.width = size.width;
    facts.height = size.height;
  }
  return facts;
}

function factsFromBuffer(buf) {
  if (!buf || buf.length < 8) return {};
  if (buf[0] === 0xff && buf[1] === 0xd8) return factsFromJpeg(buf);
  const endian = buf.toString("latin1", 0, 2);
  if (endian === "II" || endian === "MM") return parseTiffFacts(buf) || {};
  const at = buf.indexOf("Exif\0\0");
  if (at >= 0) return parseTiffFacts(buf.subarray(at + 6)) || {};
  return {};
}

export function readPhotoFacts(filePath) {
  let fh;
  try {
    fh = fs.openSync(filePath, "r");
    const take = Math.min(fs.fstatSync(fh).size, 8 * 1024 * 1024);
    const buf = Buffer.alloc(take);
    fs.readSync(fh, buf, 0, take, 0);
    return factsFromBuffer(buf);
  } catch {
    return {};
  } finally {
    if (fh != null) fs.closeSync(fh);
  }
}

export function describePhoto(photo, facts = {}) {
  const fields = [];
  const add = (label, value) => {
    if (value == null || value === "") return;
    fields.push({ label, value: String(value) });
  };
  add("文件名", photo.name);
  add("拍摄时间", prettyTime(facts.time) || (photo.year ? `${photo.year}年${photo.month}月${photo.day}日` : ""));
  add("尺寸", facts.width && facts.height ? `${facts.width} × ${facts.height}` : "");
  add("大小", formatBytes(photo.size));
  add("相机", [facts.make, facts.model].filter(Boolean).join(" "));
  add("镜头", facts.lens);
  add("光圈", facts.aperture != null ? `f/${trimNum(facts.aperture)}` : "");
  add("快门", facts.exposure != null ? formatShutter(facts.exposure) : "");
  add("感光度", facts.iso != null ? `ISO ${facts.iso}` : "");
  add("焦距", facts.focal != null ? `${trimNum(facts.focal)} mm` : "");
  add("等效焦距", facts.focal35 ? `${facts.focal35} mm` : "");
  add("曝光补偿", facts.bias != null ? `${facts.bias > 0 ? "+" : ""}${trimNum(facts.bias)} EV` : "");
  add("曝光程序", PROGRAM[facts.program] || "");
  add("测光", METER[facts.metering] || "");
  add("闪光灯", facts.flash == null ? "" : ((facts.flash & 1) ? "闪光" : "未闪光"));
  add("白平衡", facts.whiteBalance == null ? "" : (facts.whiteBalance === 0 ? "自动" : "手动"));
  add("位置", formatGps(facts));
  add("描述", facts.description);
  add("作者", facts.artist);
  add("版权", facts.copyright);
  add("软件", facts.software);
  add("文件夹", photo.dir);
  if (photo.rating) add("星级", `${photo.rating} 星`);
  return fields;
}
