import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "python", "phash_files.py");

function pythonCandidates() {
  const local = process.env.LOCALAPPDATA;
  return [
    path.join(root, ".venv", "Scripts", "python.exe"),
    local ? path.join(local, "Programs", "Python", "Python312", "python.exe") : "",
    local ? path.join(local, "Programs", "Python", "Python313", "python.exe") : "",
  ].filter(Boolean);
}

export function pythonExecutable() {
  for (const candidate of pythonCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "python";
}

export function phashFiles(paths, { isCancelled, onItem } = {}) {
  if (!paths.length) return Promise.resolve(new Map());
  const python = pythonExecutable();
  if (python !== "python" && !fs.existsSync(python)) {
    return Promise.reject(new Error("没有找到 Python，画面比对不可用"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { windowsHide: true });
    const hashes = new Map();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (error) reject(error);
      else resolve(hashes);
    };
    const timer = setInterval(() => {
      if (isCancelled?.()) {
        child.kill();
        finish(Object.assign(new Error("扫描已停止"), { name: "ScanCancelled" }));
      }
    }, 200);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      let split = stdout.indexOf("\n");
      while (split >= 0) {
        const line = stdout.slice(0, split).trim();
        stdout = stdout.slice(split + 1);
        if (line) {
          try {
            const row = JSON.parse(line);
            if (row.phash) hashes.set(row.path, row.phash);
            onItem?.(row);
          } catch {
            /* 忽略半行之外的坏数据，完整行才会进这里 */
          }
        }
        split = stdout.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish(new Error("没有找到 Python，画面比对不可用")));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0 && !hashes.size) {
        finish(new Error(stderr.trim() || "画面比对失败"));
        return;
      }
      finish();
    });
    child.stdin.write(`${paths.join("\n")}\n`, "utf8");
    child.stdin.end();
  });
}
