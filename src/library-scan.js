import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { extensionsFor, isRawExt } from "./extensions.js";
import { walkMedia } from "./engine.js";
import { readCapture } from "./metadata.js";
import { probeMedia } from "./photo-info.js";

const PHOTO_KINDS = { dslrRaw: true, dslrJpeg: true, applePhoto: true, video: false };

export function parseDriveList(text) {
  const drives = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const id = line.trim().toUpperCase();
    if (/^[A-Z]:$/.test(id)) drives.push(`${id}\\`);
  }
  return drives;
}

export function listDrives() {
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 } | ForEach-Object { $_.DeviceID }",
    ], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    const drives = parseDriveList(output);
    if (drives.length) return drives;
  } catch {
    // 下面按盘符再试一次。
  }
  const found = [];
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      fs.accessSync(root, fs.constants.R_OK);
      found.push(root);
    } catch {
      // 这个盘符不存在或打不开。
    }
  }
  return found;
}

export function utcParts(ms) {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function localParts(ms) {
  const date = new Date(ms);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

const PHONE_TEXT = /iPhone|iPad|HUAWEI|Huawei|Xiaomi|Redmi|OPPO|vivo|Pixel|Galaxy|ONEPLUS|OnePlus|HONOR|Honor|realme|Motorola|Nokia|Xperia|MEIZU|ZTE|Nothing Phone/i;
const CAMERA_TEXT = /Canon|Nikon|FUJIFILM|Fujifilm|OLYMPUS|OM System|Panasonic|LUMIX|Leica|PENTAX|Hasselblad|GoPro|HERO|DJI|RICOH|ILCE|EOS |NIKON Z|Phase One/i;

export function classifyOrigin(ext, text) {
  const lower = String(ext || "").toLowerCase();
  if (isRawExt(lower)) return "camera";
  const blob = String(text || "");
  const phone = PHONE_TEXT.test(blob);
  const camera = CAMERA_TEXT.test(blob);
  if (phone && camera) return /Xperia|iPhone|iPad|Galaxy|Pixel|HUAWEI|Xiaomi|OPPO|vivo|HONOR|OnePlus|realme/i.test(blob) ? "phone" : "camera";
  if (phone) return "phone";
  if (camera) return "camera";
  if (lower === ".heic" || lower === ".heif") return "phone";
  if (lower === ".mts" || lower === ".m2ts") return "camera";
  return "";
}

export function isExcludedDir(dir, excludeDirs) {
  const key = path.resolve(String(dir || "")).replace(/[\\/]+$/, "").toLowerCase();
  for (const raw of excludeDirs || []) {
    const root = path.resolve(String(raw || "")).replace(/[\\/]+$/, "").toLowerCase();
    if (!root) continue;
    if (key === root || key.startsWith(`${root}${path.sep}`)) return true;
  }
  return false;
}

export function passesMinEdge(width, height, minEdge) {
  const min = Number(minEdge) || 0;
  if (!min) return true;
  if (!width || !height) return true;
  return Math.max(width, height) >= min;
}

export function catalogFiles(roots, options = {}) {
  const kind = options.kind === "video" ? "video" : "photo";
  const extensions = extensionsFor(kind === "video" ? { video: true } : PHOTO_KINDS);
  const excludeDirs = options.excludeDirs || [];
  const minEdge = Number(options.minEdge) || 0;
  const onFile = options.onFile || (() => {});
  return walkMedia(roots, extensions, options.isCancelled || (() => false), (file) => {
    const probe = probeMedia(file.path, file.ext);
    if (!passesMinEdge(probe.width, probe.height, minEdge)) return;
    const meta = readCapture(file.path, file.ext, file.size);
    const known = meta.capture?.captureMs != null;
    const captureMs = known ? meta.capture.captureMs : file.mtimeMs;
    const parts = known ? utcParts(captureMs) : localParts(captureMs);
    onFile({
      path: file.path,
      name: file.name,
      ext: file.ext,
      dir: path.dirname(file.path),
      size: file.size,
      mtimeMs: file.mtimeMs,
      captureMs,
      year: parts.year,
      month: parts.month,
      day: parts.day,
      kind,
      origin: classifyOrigin(file.ext, probe.text),
      width: probe.width || 0,
      height: probe.height || 0,
    });
  }, options.onProgress || (() => {}), {
    skipDir: (dir) => isExcludedDir(dir, excludeDirs),
  });
}

const CAMERA_PAIR = {
  ".cr2": [".jpg", ".jpeg"],
  ".jpg": [".jpeg", ".cr2"],
  ".jpeg": [".jpg", ".cr2"],
};

export function pairedCameraPaths(filePath) {
  const resolved = path.resolve(filePath);
  const wanted = CAMERA_PAIR[path.extname(resolved).toLowerCase()] || [];
  const found = [resolved];
  if (!wanted.length) return found;
  const stem = path.parse(resolved).name.toLowerCase();
  let entries = [];
  try {
    entries = fs.readdirSync(path.dirname(resolved), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (path.parse(entry.name).name.toLowerCase() !== stem) continue;
    if (!wanted.includes(path.extname(entry.name).toLowerCase())) continue;
    const full = path.resolve(path.dirname(resolved), entry.name);
    if (found.some((item) => item.toLowerCase() === full.toLowerCase())) continue;
    found.push(full);
  }
  return found;
}
