import { parentPort, workerData } from "node:worker_threads";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pythonExecutable } from "./phash.js";

const flag = new Int32Array(workerData.sab);
const python = pythonExecutable();
const script = fileURLToPath(new URL("../python/recognize.py", import.meta.url));
const child = spawn(python, [script], { windowsHide: true });
let stdout = "";
let stderr = "";
let settled = false;

function post(message) {
  parentPort.postMessage(message);
}

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
  let split = stdout.indexOf("\n");
  while (split >= 0) {
    const line = stdout.slice(0, split).trim();
    stdout = stdout.slice(split + 1);
    if (line) {
      try {
        post({ type: "item", item: JSON.parse(line) });
      } catch {
        stderr += line;
      }
    }
    split = stdout.indexOf("\n");
  }
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
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
child.stdin.write(`${(workerData.paths || []).join("\n")}\n`, "utf8");
child.stdin.end();
