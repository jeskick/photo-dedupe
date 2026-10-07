import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { extensionsFor } from "./extensions.js";
import { applyDeletions } from "./delete.js";
import { pickFolders, revealPath } from "./picker.js";
import { renderPreviewJpeg } from "./preview.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");
const jobs = new Map();

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error("请求过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求格式不正确"));
      }
    });
    req.on("error", reject);
  });
}

function emit(job, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of job.listeners) res.write(payload);
}

function remember(job, group) {
  const index = job.groups.findIndex((item) => item.id === group.id);
  if (index >= 0) {
    for (const file of job.groups[index].files) job.fileIndex.delete(file.pathKey);
    job.groups[index] = group;
  } else {
    job.groups.push(group);
  }
  for (const file of group.files) job.fileIndex.set(file.pathKey, file);
}

function settle(job, status, extra = {}) {
  if (job.settled) return;
  job.settled = true;
  job.status = status;
  if (extra.summary) job.summary = extra.summary;
  if (extra.message) job.error = extra.message;
  const event = status === "done" ? "done" : status === "cancelled" ? "cancelled" : "failed";
  emit(job, event, extra.summary || { error: job.error, groups: job.groups.length });
}

function runningJob() {
  return [...jobs.values()].find((job) => job.status === "running") || null;
}

function cancelJob(job) {
  if (!job || job.status !== "running") return false;
  Atomics.store(job.flag, 0, 1);
  setTimeout(() => job.worker?.terminate(), 1500);
  return true;
}

function startJob(body) {
  const running = Boolean(runningJob());
  if (running) {
    const error = new Error("已有扫描在进行，请先停止或等待结束");
    error.status = 409;
    throw error;
  }
  const extensions = [...extensionsFor({
    dslrRaw: Boolean(body.kinds?.dslrRaw),
    dslrJpeg: Boolean(body.kinds?.dslrJpeg),
    applePhoto: Boolean(body.kinds?.applePhoto),
    video: Boolean(body.kinds?.video),
  })];
  if (!extensions.length) {
    const error = new Error("请至少选择一种文件类型");
    error.status = 400;
    throw error;
  }
  if (!Array.isArray(body.roots) || !body.roots.length) {
    const error = new Error("请先添加要扫描的文件夹");
    error.status = 400;
    throw error;
  }
  const nameMode = ["normalized", "exact", "ignore"].includes(body.nameMode) ? body.nameMode : "normalized";
  const sab = new SharedArrayBuffer(4);
  const job = {
    id: crypto.randomUUID(),
    status: "running",
    settled: false,
    groups: [],
    fileIndex: new Map(),
    progress: { phase: "准备扫描", files: 0, dirs: 0, groups: 0 },
    summary: null,
    error: null,
    listeners: new Set(),
    flag: new Int32Array(sab),
    worker: null,
  };
  jobs.set(job.id, job);
  for (const [id, existing] of jobs) {
    if (existing.status === "running" || id === job.id) continue;
    if (jobs.size > 3) jobs.delete(id);
  }
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    workerData: {
      roots: body.roots,
      extensions,
      nameMode,
      toleranceSec: Math.min(120, Math.max(0, Number(body.toleranceSec) || 0)),
      matchWithoutTime: body.matchWithoutTime !== false,
      similar: body.similar === true,
      similarDistance: Math.min(12, Math.max(0, Number.isFinite(Number(body.similarDistance)) ? Number(body.similarDistance) : 4)),
      sab,
    },
  });
  job.worker = worker;
  worker.on("message", (message) => {
    if (message.type === "progress") {
      job.progress = message.progress;
      emit(job, "progress", message.progress);
    } else if (message.type === "group") {
      remember(job, message.group);
      emit(job, "group", message.group);
    } else if (message.type === "done") {
      job.summary = message.summary;
      settle(job, "done", { summary: message.summary });
    } else if (message.type === "cancelled") {
      settle(job, "cancelled", { summary: { cancelled: true, groups: job.groups.length } });
    } else if (message.type === "failed") {
      settle(job, "failed", { message: message.message || "扫描失败" });
    }
  });
  worker.on("error", (error) => settle(job, "failed", { message: error.message }));
  worker.on("exit", (code) => {
    if (!job.settled && code !== 0) settle(job, "failed", { message: `扫描已中断 (${code})` });
  });
  return job;
}

function findGroup(job, groupId) {
  return job.groups.find((group) => group.id === groupId) || null;
}

function setFileRole(job, body) {
  const group = findGroup(job, body.groupId);
  if (!group) return "找不到这一组";
  const key = path.resolve(String(body.path || "")).toLowerCase();
  const file = group.files.find((item) => item.pathKey === key);
  if (!file) return "找不到这个文件";
  const role = body.role;
  if (!["keep", "delete", "spare"].includes(role)) return "操作无效";
  if (role !== "keep" && file.role === "keep") return "请先把另一份标为保留";
  if (role === "keep") {
    for (const item of group.files) {
      if (item !== file && item.role === "keep") item.role = "delete";
    }
  }
  file.role = role;
  group.wasted = group.files.reduce((sum, item) => sum + (item.role === "delete" ? item.size : 0), 0);
  return null;
}

function formatCapture(ms, subsecKnown) {
  if (ms == null) return "无拍摄时间";
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  const text = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return subsecKnown ? `${text}.${String(date.getUTCMilliseconds()).padStart(3, "0")}` : text;
}

function csvCell(value) {
  const text = String(value ?? "");
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function reportCsv(job) {
  const lines = [["组", "处理", "来源", "操作", "文件名", "拍摄时间", "大小", "路径", "内容哈希"].map(csvCell).join(",")];
  for (const group of job.groups) {
    for (const file of group.files) {
      const action = file.role === "keep" ? "保留" : file.role === "spare" ? "跳过" : "移入回收站";
      const origin = file.origin === "original" ? "原始" : file.origin === "copy" ? "复制" : "";
      lines.push([
        group.id,
        group.enabled ? "是" : "否",
        origin,
        action,
        file.name,
        formatCapture(file.captureMs, file.subsecKnown),
        file.size,
        file.path,
        file.hash,
      ].map(csvCell).join(","));
    }
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function findJobFile(job, rawPath) {
  if (!rawPath) return null;
  return job.fileIndex.get(path.resolve(rawPath).toLowerCase()) || null;
}

function contentType(ext) {
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".heic" || ext === ".heif") return "image/heic";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  return "";
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && (url.pathname === "/" || TYPES[path.extname(url.pathname)])) {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const filePath = path.resolve(publicDir, rel);
      const root = path.resolve(publicDir);
      if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        sendJson(res, 404, { error: "未找到页面" });
        return;
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(res, 404, { error: "未找到页面" });
        return;
      }
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; img-src 'self'; media-src 'self'; style-src 'self'; script-src 'self'",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(data);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pick") {
      const body = await readBody(req);
      const paths = await pickFolders(body.mode === "one" ? "one" : "multi");
      sendJson(res, 200, { paths });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/scan/active") {
      const job = runningJob();
      sendJson(res, 200, job ? { jobId: job.id, status: job.status, progress: job.progress } : { jobId: null });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/scan/cancel") {
      const job = runningJob();
      if (!job) {
        sendJson(res, 200, { ok: true, stopped: false });
        return;
      }
      cancelJob(job);
      sendJson(res, 200, { ok: true, stopped: true, jobId: job.id });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/scan") {
      const body = await readBody(req);
      const job = startJob(body);
      sendJson(res, 200, { jobId: job.id });
      return;
    }

    const events = url.pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
    if (req.method === "GET" && events) {
      const job = jobs.get(events[1]);
      if (!job) {
        sendJson(res, 404, { error: "扫描不存在" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      job.listeners.add(res);
      for (const group of job.groups) res.write(`event: group\ndata: ${JSON.stringify(group)}\n\n`);
      res.write(`event: progress\ndata: ${JSON.stringify(job.progress)}\n\n`);
      if (job.status === "done") res.write(`event: done\ndata: ${JSON.stringify(job.summary)}\n\n`);
      if (job.status === "cancelled") res.write(`event: cancelled\ndata: ${JSON.stringify({ cancelled: true, groups: job.groups.length })}\n\n`);
      if (job.status === "failed") res.write(`event: failed\ndata: ${JSON.stringify({ error: job.error })}\n\n`);
      const timer = setInterval(() => res.write(": ping\n\n"), 15000);
      res.on("close", () => {
        clearInterval(timer);
        job.listeners.delete(res);
      });
      return;
    }

    const jobPath = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/([^/]+))?$/);
    if (jobPath) {
      const job = jobs.get(jobPath[1]);
      if (!job) {
        sendJson(res, 404, { error: "扫描不存在" });
        return;
      }
      const action = jobPath[2] || "";
      if (req.method === "POST" && action === "cancel") {
        cancelJob(job);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && action === "file") {
        const body = await readBody(req);
        const error = setFileRole(job, body);
        if (error) sendJson(res, 400, { error });
        else sendJson(res, 200, { ok: true, wasted: findGroup(job, body.groupId)?.wasted || 0 });
        return;
      }
      if (req.method === "POST" && action === "group") {
        const body = await readBody(req);
        const group = findGroup(job, body.groupId);
        if (!group) {
          sendJson(res, 404, { error: "找不到这一组" });
          return;
        }
        group.enabled = Boolean(body.enabled);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && action === "delete") {
        if (job.status === "running") {
          sendJson(res, 409, { error: "扫描还在进行" });
          return;
        }
        const body = await readBody(req);
        const result = await applyDeletions(job, { includeSidecars: body.includeSidecars !== false });
        sendJson(res, 200, {
          deleted: result.deleted.map((item) => item.path),
          freedBytes: result.freedBytes,
          skipped: result.skipped,
          sidecars: result.sidecars,
          groups: job.groups,
        });
        return;
      }
      if (req.method === "GET" && action === "report.csv") {
        const csv = Buffer.from(reportCsv(job), "utf8");
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=duplicates.csv",
          "Content-Length": csv.length,
          "Cache-Control": "no-store",
        });
        res.end(csv);
        return;
      }
      if (req.method === "GET" && action === "preview") {
        const file = findJobFile(job, url.searchParams.get("path"));
        if (!file) {
          sendJson(res, 404, { error: "文件不在本次结果中" });
          return;
        }
        try {
          const jpeg = await renderPreviewJpeg(file.path, `${file.size}:${file.mtimeMs}`);
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": jpeg.length,
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(jpeg);
        } catch {
          sendJson(res, 422, { error: "这张预览打不开" });
        }
        return;
      }
      if (req.method === "GET" && action === "raw") {
        const file = findJobFile(job, url.searchParams.get("path"));
        if (!file) {
          sendJson(res, 404, { error: "文件不在本次结果中" });
          return;
        }
        const type = contentType(path.extname(file.path).toLowerCase());
        if (!type) {
          sendJson(res, 415, { error: "这个格式不能在页面里预览" });
          return;
        }
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff" });
        const stream = fs.createReadStream(file.path);
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/reveal") {
      const body = await readBody(req);
      const target = path.resolve(String(body.path || ""));
      const allowed = [...jobs.values()].some((job) => job.fileIndex.has(target.toLowerCase()));
      if (!allowed) {
        sendJson(res, 404, { error: "只能打开本次扫描到的文件" });
        return;
      }
      if (!fs.existsSync(target)) {
        sendJson(res, 404, { error: "文件已经不在原处" });
        return;
      }
      await revealPath(target);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "未找到" });
  } catch (error) {
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message || "处理失败" });
  }
}

function openBrowser(url) {
  spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function start(port) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: error.message || "处理失败" });
    });
  });
  const base = port;
  let current = port;
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && current < base + 20) {
      current += 1;
      server.listen(current, "127.0.0.1");
      return;
    }
    console.error(error.message || error);
    process.exit(1);
  });
  server.on("listening", () => {
    const url = `http://127.0.0.1:${current}/`;
    console.log(`相片视频查重已启动 ${url}`);
    if (!process.env.NO_OPEN) openBrowser(url);
  });
  server.listen(current, "127.0.0.1");
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) start(Number(process.env.PORT) || 8765);
