import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "native", "filetools.ps1");

function run(action, { title, listFile, target } = {}) {
  const outFile = path.join(os.tmpdir(), `photo-dedupe-${process.pid}-${Date.now()}-${action}.json`);
  return new Promise((resolve, reject) => {
    const args = [
      "-NoProfile",
      "-STA",
      "-WindowStyle", "Hidden",
      "-ExecutionPolicy", "Bypass",
      "-File", script,
      "-Action", action,
      "-OutFile", outFile,
    ];
    if (listFile) args.push("-ListFile", listFile);
    if (target) args.push("-Target", target);
    const child = spawn("powershell.exe", args, {
      windowsHide: true,
      env: { ...process.env, PICK_TITLE: title || "" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let text = "";
      try {
        text = fs.readFileSync(outFile, "utf8").replace(/^\uFEFF/, "");
      } catch {
        text = "";
      }
      fs.rmSync(outFile, { force: true });
      if (code !== 0) {
        reject(new Error(text || stderr || "系统窗口调用失败"));
        return;
      }
      resolve(text);
    });
  });
}

export function probeNative() {
  return run("probe");
}

export async function pickFolders(mode) {
  const title = mode === "one"
    ? "选择要扫描的文件夹"
    : "选择要扫描的文件夹，可按住 Ctrl 多选";
  const text = await run(mode === "one" ? "pick-one" : "pick", { title });
  const parsed = JSON.parse(text || "[]");
  if (parsed == null) return [];
  return Array.isArray(parsed) ? parsed.filter(Boolean) : [String(parsed)];
}

export function revealPath(target) {
  return new Promise((resolve, reject) => {
    const child = spawn("explorer.exe", ["/select,", target], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", () => reject(new Error("无法打开文件所在位置")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function recyclePaths(paths) {
  if (!paths.length) return [];
  const listFile = path.join(os.tmpdir(), `photo-dedupe-recycle-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(listFile, `${paths.join("\n")}\n`, "utf8");
  try {
    const text = await run("recycle", { listFile });
    const parsed = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } finally {
    fs.rmSync(listFile, { force: true });
  }
}
