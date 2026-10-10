import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { extensionsFor } from "./extensions.js";
import { compileNamePatterns } from "./patterns.js";
import { applyDeletions } from "./delete.js";
import { pickFolders, recyclePaths, revealPath } from "./picker.js";
import { renderPreviewJpeg, renderVideoFrame } from "./preview.js";
import { listDrives, pairedCameraPaths } from "./library-scan.js";
import { ensurePeopleClusters, forgetMissingPhotos, libraryCount, libraryKindTotals, libraryMarks, libraryMeta, libraryPhoto, libraryPhotoPaths, librarySettings, libraryTree, loadPeople, openLibrary, photoFaces, prepareRecognition, purgeScan, queryPhotos, removePhotos, renameFace, renamePerson, saveLibrarySettings, saveRecognition, setLibraryMeta, setRating, upsertPhotos } from "./library-db.js";
import { describePhoto, readPhotoFacts } from "./photo-info.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");
const libraryDbPath = process.env.LIBRARY_DB || path.join(here, "..", "data", "library.sqlite");
const jobs = new Map();
let libraryDb = null;
let libraryJob = null;
let recognizeJob = null;
let recognizeNote = "";

function photosDb() {
  if (!libraryDb) libraryDb = openLibrary(libraryDbPath);
  return libraryDb;
}

function libraryState() {
  const db = photosDb();
  const meta = libraryMeta(db);
  let summary = null;
  try {
    summary = meta.summary ? JSON.parse(meta.summary) : null;
  } catch {
    summary = null;
  }
  const totals = libraryKindTotals(db);
  return {
    total: totals.photo.count + totals.video.count,
    photos: totals.photo.count,
    videos: totals.video.count,
    photoBytes: totals.photo.bytes,
    videoBytes: totals.video.bytes,
    scanning: Boolean(libraryJob),
    progress: libraryJob?.progress || null,
    recognizing: Boolean(recognizeJob),
    recognize: recognizeJob?.progress || null,
    recognizeNote,
    summary,
  };
}

function emitLibrary(event, data, done = false) {
  if (!libraryJob) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of libraryJob.listeners) {
    res.write(payload);
    if (done) res.end();
  }
  if (done) libraryJob.listeners.clear();
}

function finishLibrary(status, summary) {
  const job = libraryJob;
  if (!job || job.settled) return;
  job.settled = true;
  if (status === "done") {
    const kind = job.kind === "video" ? "video" : "photo";
    const seen = libraryCount(photosDb(), kind);
    const removed = purgeScan(photosDb(), job.scanId, kind, job.roots);
    const total = libraryCount(photosDb(), kind);
    const added = Math.max(0, seen - (job.beforeCount || 0));
    const saved = {
      finishedAt: Date.now(),
      files: summary?.files || 0,
      dirs: summary?.dirs || 0,
      softwareSkipped: summary?.softwareSkipped || 0,
      roots: job.roots,
      added,
      removed,
    };
    setLibraryMeta(photosDb(), "summary", JSON.stringify(saved));
    emitLibrary("done", { ...saved, total }, true);
  } else if (status === "cancelled") {
    emitLibrary("cancelled", { total: libraryCount(photosDb()) }, true);
  } else {
    emitLibrary("failed", { error: summary?.error || "扫描失败" }, true);
  }
  libraryJob = null;
}

function startLibraryScan(kind) {
  const media = kind === "video" ? "video" : "photo";
  if (runningJob() || libraryJob || recognizeJob) {
    const error = new Error("已有扫描在进行，请先停止或等待结束");
    error.status = 409;
    throw error;
  }
  const roots = listDrives();
  if (!roots.length) {
    const error = new Error("没有找到可以扫描的磁盘");
    error.status = 400;
    throw error;
  }
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const scanId = Date.now();
  const settings = librarySettings(photosDb());
  const beforeCount = libraryCount(photosDb(), media);
  libraryJob = {
    worker: null,
    flag,
    scanId,
    kind: media,
    beforeCount,
    roots,
    listeners: new Set(),
    settled: false,
    progress: { phase: "正在扫描全部磁盘", dirs: 0, files: 0, softwareSkipped: 0 },
  };
  const worker = new Worker(new URL("./library-worker.js", import.meta.url), {
    workerData: {
      roots,
      sab,
      scanId,
      kind: media,
      excludeDirs: settings.excludeDirs,
      minEdge: media === "video" ? settings.minEdgeVideo : settings.minEdgePhoto,
    },
  });
  libraryJob.worker = worker;
  worker.on("message", (message) => {
    if (!libraryJob || libraryJob.worker !== worker) return;
    if (message.type === "batch") {
      upsertPhotos(photosDb(), message.files || [], scanId);
      return;
    }
    if (message.type === "progress") {
      libraryJob.progress = { phase: "正在扫描全部磁盘", ...message.progress };
      emitLibrary("progress", libraryJob.progress);
      return;
    }
    if (message.type === "done") finishLibrary("done", message.summary);
    else if (message.type === "cancelled") finishLibrary("cancelled", message.summary);
    else if (message.type === "failed") finishLibrary("failed", { error: message.message });
  });
  worker.on("error", (error) => finishLibrary("failed", { error: error.message || "扫描失败" }));
  return { roots, scanId };
}

function startRecognize(onlyPath) {
  if (runningJob() || libraryJob || recognizeJob) {
    const error = new Error("已有扫描在进行，请先停止或等待结束");
    error.status = 409;
    throw error;
  }
  const paths = onlyPath ? [onlyPath] : libraryPhotoPaths(photosDb());
  if (onlyPath && !libraryPhoto(photosDb(), onlyPath)) {
    const error = new Error("照片不在库里");
    error.status = 404;
    throw error;
  }
  if (!paths.length) {
    const error = new Error("照片库还是空的，先扫描再识别");
    error.status = 400;
    throw error;
  }
  prepareRecognition(photosDb());
  const sab = new SharedArrayBuffer(4);
  const people = loadPeople(photosDb());
  recognizeNote = "";
  recognizeJob = {
    flag: new Int32Array(sab),
    worker: null,
    people,
    progress: { phase: "正在准备分类", done: 0, total: paths.length, faceDone: 0, faceTotal: 0 },
  };
  const worker = new Worker(new URL("./recognize-worker.js", import.meta.url), {
    workerData: { paths, sab },
  });
  recognizeJob.worker = worker;
  worker.on("message", (message) => {
    if (!recognizeJob || recognizeJob.worker !== worker) return;
    if (message.type === "status") {
      const progress = { ...recognizeJob.progress, phase: message.message };
      if (Number.isFinite(message.faceTotal)) progress.faceTotal = message.faceTotal;
      recognizeJob.progress = progress;
      return;
    }
    if (message.type === "item") {
      const item = message.item || {};
      if (item.path && !item.error) {
        saveRecognition(photosDb(), item.path, item.faces || [], item.labels || [], recognizeJob.people);
      }
      if (item.pass === "face") {
        recognizeJob.progress = {
          ...recognizeJob.progress,
          phase: "正在识别人物",
          faceDone: (recognizeJob.progress.faceDone || 0) + 1,
        };
      } else {
        recognizeJob.progress = {
          ...recognizeJob.progress,
          phase: "正在区分风景",
          done: recognizeJob.progress.done + 1,
          total: recognizeJob.progress.total,
        };
      }
      return;
    }
    if (message.type === "done" || message.type === "cancelled") {
      try { ensurePeopleClusters(photosDb(), true); } catch { /* 分组失败不影响已经认出的脸 */ }
    }
    if (message.type === "failed") recognizeNote = message.message || "人物识别失败";
    if (message.type === "cancelled") recognizeNote = "已停止识别。已经归好的组会留在左侧。";
    if (message.type === "done") recognizeNote = "";
    if (message.type === "done" || message.type === "cancelled" || message.type === "failed") {
      recognizeJob = null;
    }
  });
  worker.on("error", () => {
    recognizeJob = null;
  });
  return { total: paths.length };
}

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

const VIDEO_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mts": "video/mp2t",
  ".m2ts": "video/mp2t",
};

function streamFile(req, res, filePath, type) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    sendJson(res, 404, { error: "文件不在了" });
    return;
  }
  const header = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  };
  const match = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  let start = 0;
  let end = size - 1;
  if (match) {
    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    end = Math.min(end, size - 1);
    if (!match[2] && end - start + 1 > 8 * 1024 * 1024) end = start + 8 * 1024 * 1024 - 1;
  }
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on("error", () => {
    if (!res.headersSent) sendJson(res, 404, { error: "文件读不开" });
    else res.destroy();
  });
  res.on("close", () => stream.destroy());
  if (match) {
    res.writeHead(206, {
      ...header,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": end - start + 1,
    });
  } else {
    res.writeHead(200, { ...header, "Content-Length": size });
  }
  stream.pipe(res);
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
  const running = Boolean(runningJob()) || Boolean(libraryJob) || Boolean(recognizeJob);
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
  const settings = librarySettings(photosDb());
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    workerData: {
      roots: body.roots,
      extensions,
      nameMode,
      toleranceSec: Math.min(120, Math.max(0, Number(body.toleranceSec) || 0)),
      matchWithoutTime: body.matchWithoutTime !== false,
      similar: body.similar === true,
      similarDistance: Math.min(12, Math.max(0, Number.isFinite(Number(body.similarDistance)) ? Number(body.similarDistance) : 4)),
      excludeDirs: settings.excludeDirs,
      minEdgePhoto: settings.minEdgePhoto,
      minEdgeVideo: settings.minEdgeVideo,
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

function startSearch(body) {
  const running = Boolean(runningJob()) || Boolean(libraryJob) || Boolean(recognizeJob);
  if (running) {
    const error = new Error("已有扫描在进行，请先停止或等待结束");
    error.status = 409;
    throw error;
  }
  let patterns = [];
  try {
    patterns = compileNamePatterns(body.patterns).list;
  } catch (error) {
    error.status = error.status || 400;
    throw error;
  }
  if (!patterns.length) {
    const error = new Error("请填写文件名，例如 *.zip 或 *kk*.zip");
    error.status = 400;
    throw error;
  }
  if (!Array.isArray(body.roots) || !body.roots.length) {
    const error = new Error("请先添加要搜索的文件夹");
    error.status = 400;
    throw error;
  }
  const sab = new SharedArrayBuffer(4);
  const job = {
    id: crypto.randomUUID(),
    mode: "search",
    status: "running",
    settled: false,
    groups: [],
    files: [],
    found: 0,
    foundBytes: 0,
    fileIndex: new Map(),
    progress: { phase: "准备搜索", files: 0, dirs: 0, bytes: 0 },
    summary: null,
    error: null,
    listeners: new Set(),
    flag: new Int32Array(sab),
    worker: null,
  };
  jobs.set(job.id, job);
  const excludeDirs = Array.isArray(body.excludeDirs)
    ? body.excludeDirs.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 40)
    : [];
  const worker = new Worker(new URL("./search-worker.js", import.meta.url), {
    workerData: {
      roots: body.roots,
      patterns,
      excludeDirs,
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
      settle(job, "cancelled", { summary: { cancelled: true, files: job.found, bytes: job.foundBytes } });
    } else if (message.type === "failed") {
      settle(job, "failed", { message: message.message || "搜索失败" });
    }
  });
  worker.on("error", (error) => settle(job, "failed", { message: error.message }));
  worker.on("exit", (code) => {
    if (!job.settled && code !== 0) settle(job, "failed", { message: `搜索已中断 (${code})` });
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

    if (req.method === "POST" && url.pathname === "/api/search") {
      const body = await readBody(req);
      const job = startSearch(body);
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
          const ext = path.extname(file.path).toLowerCase();
          const render = VIDEO_TYPES[ext] ? renderVideoFrame : renderPreviewJpeg;
          const jpeg = await render(file.path, `${file.size}:${file.mtimeMs}`);
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
        const ext = path.extname(file.path).toLowerCase();
        const type = VIDEO_TYPES[ext] || contentType(ext);
        if (!type) {
          sendJson(res, 415, { error: "这个格式不能在页面里预览" });
          return;
        }
        streamFile(req, res, file.path, type);
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/library/state") {
      sendJson(res, 200, libraryState());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/library/tree") {
      sendJson(res, 200, {
        days: libraryTree(photosDb(), {
          rating: url.searchParams.get("rating"),
        kind: url.searchParams.get("kind"),
        origin: url.searchParams.get("origin"),
        label: url.searchParams.get("label"),
        person: url.searchParams.get("person"),
        personId: url.searchParams.get("personId"),
        personIds: url.searchParams.get("personIds"),
        }),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/library/photos") {
      const photos = queryPhotos(photosDb(), {
        year: url.searchParams.get("year"),
        month: url.searchParams.get("month"),
        day: url.searchParams.get("day"),
        rating: url.searchParams.get("rating"),
        kind: url.searchParams.get("kind"),
        origin: url.searchParams.get("origin"),
        label: url.searchParams.get("label"),
        person: url.searchParams.get("person"),
        personId: url.searchParams.get("personId"),
        personIds: url.searchParams.get("personIds"),
        q: url.searchParams.get("q"),
        offset: url.searchParams.get("offset"),
        limit: url.searchParams.get("limit"),
      });
      sendJson(res, 200, { photos });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/library/settings") {
      sendJson(res, 200, librarySettings(photosDb()));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/library/settings") {
      const body = await readBody(req);
      sendJson(res, 200, saveLibrarySettings(photosDb(), body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/library/scan") {
      const body = await readBody(req);
      const started = startLibraryScan(body.kind);
      sendJson(res, 200, started);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/library/marks") {
      sendJson(res, 200, libraryMarks(photosDb()));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/library/recognize") {
      const body = await readBody(req);
      const onlyPath = body.path ? path.resolve(String(body.path)) : "";
      const started = startRecognize(onlyPath);
      sendJson(res, 200, started);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/library/recognize/cancel") {
      if (recognizeJob) Atomics.store(recognizeJob.flag, 0, 1);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/library/face") {
      const body = await readBody(req);
      const result = body.personId
        ? renamePerson(photosDb(), body.personId, body.name)
        : renameFace(photosDb(), body.id, body.name);
      if (!result) {
        sendJson(res, 404, { error: "找不到这张脸" });
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/library/rating") {
      const body = await readBody(req);
      const target = path.resolve(String(body.path || ""));
      if (!libraryPhoto(photosDb(), target)) {
        sendJson(res, 404, { error: "照片不在库里" });
        return;
      }
      const rating = setRating(photosDb(), target, body.rating);
      sendJson(res, 200, { rating });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/library/delete") {
      const body = await readBody(req);
      const target = path.resolve(String(body.path || ""));
      const photo = libraryPhoto(photosDb(), target);
      if (!photo) {
        sendJson(res, 404, { error: "照片不在库里" });
        return;
      }
      const paths = pairedCameraPaths(photo.path).filter((item) => fs.existsSync(item));
      if (!body.confirm) {
        sendJson(res, 200, { paths });
        return;
      }
      if (!paths.length) {
        removePhotos(photosDb(), [photo.path]);
        sendJson(res, 200, { deleted: [photo.path], missing: true });
        return;
      }
      const results = await recyclePaths(paths);
      const deleted = results.filter((item) => item.ok).map((item) => item.path);
      const failed = results.filter((item) => !item.ok);
      if (deleted.length) removePhotos(photosDb(), deleted);
      if (!deleted.length) {
        sendJson(res, 500, { deleted, failed, error: failed[0]?.error || "没能移入回收站" });
        return;
      }
      sendJson(res, 200, { deleted, failed });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/library/cancel") {
      if (libraryJob) {
        Atomics.store(libraryJob.flag, 0, 1);
        setTimeout(() => libraryJob?.worker?.terminate(), 1500);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/library/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      if (!libraryJob) {
        res.write(`event: idle\ndata: ${JSON.stringify(libraryState())}\n\n`);
        res.end();
        return;
      }
      libraryJob.listeners.add(res);
      res.write(`event: progress\ndata: ${JSON.stringify(libraryJob.progress)}\n\n`);
      const timer = setInterval(() => res.write(": ping\n\n"), 15000);
      res.on("close", () => {
        clearInterval(timer);
        libraryJob?.listeners.delete(res);
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/library/media") {
      const photo = libraryPhoto(photosDb(), path.resolve(String(url.searchParams.get("path") || "")));
      const type = VIDEO_TYPES[String(photo?.ext || "").toLowerCase()];
      if (photo && forgetMissingPhotos(photosDb(), [photo.path]).length) {
        sendJson(res, 404, { error: "文件已经不在原处", missing: true });
        return;
      }
      if (!photo || photo.kind !== "video" || !type || !fs.existsSync(photo.path)) {
        sendJson(res, 404, { error: "视频不在库里" });
        return;
      }
      streamFile(req, res, photo.path, type);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/library/info") {
      const photo = libraryPhoto(photosDb(), path.resolve(String(url.searchParams.get("path") || "")));
      if (!photo) {
        sendJson(res, 404, { error: "照片不在库里" });
        return;
      }
      const facts = fs.existsSync(photo.path) ? readPhotoFacts(photo.path) : {};
      sendJson(res, 200, { fields: describePhoto(photo, facts), faces: photoFaces(photosDb(), photo.path) });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/api/library/thumb" || url.pathname === "/api/library/view")) {
      const photo = libraryPhoto(photosDb(), path.resolve(String(url.searchParams.get("path") || "")));
      if (photo && forgetMissingPhotos(photosDb(), [photo.path]).length) {
        sendJson(res, 404, { error: "文件已经不在原处", missing: true });
        return;
      }
      if (!photo || !fs.existsSync(photo.path)) {
        sendJson(res, 404, { error: "照片不在库里" });
        return;
      }
      const edge = url.pathname.endsWith("/view") ? 1600 : 480;
      const render = VIDEO_TYPES[String(photo.ext || "").toLowerCase()] ? renderVideoFrame : renderPreviewJpeg;
      try {
        const jpeg = await render(photo.path, `${photo.size}:${photo.mtimeMs}`, edge);
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": jpeg.length,
          "Cache-Control": edge > 480 ? "private, max-age=120" : "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(jpeg);
      } catch {
        sendJson(res, 422, { error: "这张预览打不开" });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reveal") {
      const body = await readBody(req);
      const target = path.resolve(String(body.path || ""));
      const allowed = [...jobs.values()].some((job) => job.fileIndex.has(target.toLowerCase()))
        || Boolean(libraryPhoto(photosDb(), target));
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

function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const family = entry.family;
      const ip4 = family === "IPv4" || family === 4;
      if (!ip4 || entry.internal) continue;
      if (String(entry.address).startsWith("169.254.")) continue;
      addresses.push(entry.address);
    }
  }
  return addresses;
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
      server.listen(current, "0.0.0.0");
      return;
    }
    console.error(error.message || error);
    process.exit(1);
  });
  server.on("listening", () => {
    const local = `http://127.0.0.1:${current}/`;
    const remote = lanAddresses().map((address) => `http://${address}:${current}/`);
    console.log(`相片视频查重已启动 ${local}`);
    if (remote.length) console.log(`局域网可访问 ${remote.join("  ")}`);
    if (!process.env.NO_OPEN) openBrowser(local);
  });
  server.listen(current, "0.0.0.0");
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) start(Number(process.env.PORT) || 8765);
