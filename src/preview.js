import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pythonExecutable } from "./phash.js";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "python", "preview_jpeg.py");
const cache = new Map();
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
  cache.set(key, buffer);
  if (cache.size > 48) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

export function renderPreviewJpeg(filePath, stamp, edge = 1600) {
  const size = Math.max(64, Math.min(1600, Number(edge) || 1600));
  const key = `${filePath}\0${stamp || ""}\0${size}`;
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
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
