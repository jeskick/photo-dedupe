import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pythonExecutable } from "./phash.js";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "python", "preview_jpeg.py");
const cache = new Map();
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
let cacheBytes = 0;
let active = 0;
const waiting = [];

function takeSlot() {
  if (active < 2) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  active -= 1;
  const next = waiting.shift();
  if (next) {
    active += 1;
    next();
  }
}

function remember(key, buffer) {
  const previous = cache.get(key);
  if (previous) {
    cache.delete(key);
    cacheBytes -= previous.length;
  }
  cache.set(key, buffer);
  cacheBytes += buffer.length;
  while (cache.size > 1 && cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).length;
    cache.delete(oldest);
  }
}

export function renderPreviewJpeg(filePath, stamp, edge = 1600) {
  const size = Math.max(64, Math.min(1600, Number(edge) || 1600));
  const key = `${filePath}\0${stamp || ""}\0${size}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return Promise.resolve(cached);
  }
  const python = pythonExecutable();
  return takeSlot().then(() => new Promise((resolve, reject) => {
    const child = spawn(python, [script, filePath, String(size)], { windowsHide: true });
    const chunks = [];
    const errors = [];
    let settled = false;
    const timer = setTimeout(() => child.kill(), 30000);
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseSlot();
      fn();
    };
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      const buffer = Buffer.concat(chunks);
      if (code !== 0 || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        reject(new Error(Buffer.concat(errors).toString("utf8").trim() || "无法生成预览"));
        return;
      }
      remember(key, buffer);
      resolve(buffer);
    }));
  }));
}

let ffmpegPath;

export function ffmpegExecutable() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  const listed = [];
  if (process.env.FFMPEG) listed.push(process.env.FFMPEG);
  try {
    const output = execFileSync("where.exe", ["ffmpeg"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    listed.push(...output.split(/\r?\n/));
  } catch {
    listed.push("ffmpeg");
  }
  ffmpegPath = listed.map((item) => item.trim()).find((item) => item && item !== "ffmpeg" && fs.existsSync(item)) || "";
  return ffmpegPath;
}

function collectOutput(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const chunks = [];
    const errors = [];
    let settled = false;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      const buffer = Buffer.concat(chunks);
      if (code !== 0 || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        reject(new Error(Buffer.concat(errors).toString("utf8").trim() || "无法生成预览"));
        return;
      }
      resolve(buffer);
    }));
  });
}

export function renderVideoFrame(filePath, stamp, edge = 1600) {
  const size = Math.max(64, Math.min(1600, Number(edge) || 1600));
  const key = `v\0${filePath}\0${stamp || ""}\0${size}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return Promise.resolve(cached);
  }
  const ffmpeg = ffmpegExecutable();
  if (!ffmpeg) return Promise.reject(new Error("没有找到 ffmpeg，视频预览不可用"));
  const argsFor = (seconds) => [
    "-hide_banner", "-loglevel", "error",
    "-ss", String(seconds),
    "-i", filePath,
    "-frames:v", "1",
    "-an",
    "-vf", `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
    "-q:v", "5",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "pipe:1",
  ];
  return takeSlot().then(() => collectOutput(ffmpeg, argsFor(1), 30000).catch(() => collectOutput(ffmpeg, argsFor(0), 30000))).then((buffer) => {
    remember(key, buffer);
    return buffer;
  }).finally(() => releaseSlot());
}
