import { parentPort, workerData } from "node:worker_threads";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pythonExecutable } from "./phash.js";

const flag = new Int32Array(workerData.sab);
const python = pythonExecutable();
const script = fileURLToPath(new URL("../python/recognize.py", import.meta.url));
const child = spawn(python, [script], {
  windowsHide: true,
  env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", TQDM_DISABLE: "1" },
});
let stdout = "";
let stderr = "";
let settled = false;

function post(message) {
  parentPort.postMessage(message);
}

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8").replace(/\r/g, "\n");
  let split = stdout.indexOf("\n");
  while (split >= 0) {
    const line = stdout.slice(0, split).trim();
    stdout = stdout.slice(split + 1);
    if (line) {
      try {
        const item = JSON.parse(line);
        const status = typeof item.status === "string" ? item.status.trim() : "";
        if (status && status.length <= 40 && !/[|%]/.test(status)) {
          const note = { type: "status", message: status };
          if (Number.isFinite(item.faceTotal)) note.faceTotal = item.faceTotal;
          post(note);
        }
        else if (!item.status) post({ type: "item", item });
      } catch {
        if (stderr.length < 2000) stderr += `${line.slice(0, 180)}\n`;
      }
    }
    split = stdout.indexOf("\n");
  }
});
child.stderr.on("data", (chunk) => {
  if (stderr.length < 4000) stderr += chunk.toString("utf8").slice(0, 4000 - stderr.length);
});
child.on("error", () => {
  if (settled) return;
  settled = true;
  post({ type: "failed", message: "没有找到 Python，人物识别不可用" });
});
child.on("close", (code) => {
  if (settled) return;
  settled = true;
  if (Atomics.load(flag, 0) !== 0) {
    post({ type: "cancelled" });
    return;
  }
  if (code !== 0) {
    post({ type: "failed", message: stderr.trim() || "人物识别失败" });
    return;
  }
  post({ type: "done" });
});

const timer = setInterval(() => {
  if (Atomics.load(flag, 0) === 0) return;
  clearInterval(timer);
  child.kill();
}, 300);
child.on("close", () => clearInterval(timer));
const paths = workerData.paths || [];
let pathIndex = 0;
function writePaths() {
  while (pathIndex < paths.length) {
    const ok = child.stdin.write(`${paths[pathIndex]}\n`, "utf8");
    pathIndex += 1;
    if (!ok) {
      child.stdin.once("drain", writePaths);
      return;
    }
  }
  child.stdin.end();
}
writePaths();
