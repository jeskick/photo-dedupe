import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isExcludedDir } from "./library-scan.js";
import { markOrigins, orderForKeep } from "./match.js";
import { compileNamePatterns } from "./patterns.js";
import { pruneRoots } from "./roots.js";
import { isSoftwareBoundary } from "./skip.js";

export class SearchCancelled extends Error {
  constructor() {
    super("搜索已停止");
    this.name = "SearchCancelled";
  }
}

function hashFile(filePath, isCancelled) {
  return new Promise((resolve, reject) => {
    const hash = createHash("blake2b512");
    const stream = createReadStream(filePath, { highWaterMark: 8 * 1024 * 1024 });
    stream.on("data", (chunk) => {
      if (isCancelled()) {
        stream.destroy(new SearchCancelled());
        return;
      }
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function mapPool(items, limit, fn) {
  if (!items.length) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

function publish(file, role) {
  return {
    path: file.path,
    pathKey: file.pathKey,
    name: file.name,
    ext: file.ext,
    size: file.size,
    mtimeMs: file.mtimeMs,
    birthtimeMs: file.birthtimeMs ?? null,
    captureMs: null,
    subsecKnown: false,
    source: null,
    hash: file.hash || null,
    phash: null,
    distance: null,
    origin: null,
    originReason: "",
    role,
  };
}

function makeGroup(files, seq) {
  const ordered = markOrigins(orderForKeep(files).map((file, index) => publish(file, index === 0 ? "keep" : "delete")));
  const keeper = ordered[0];
  return {
    id: `g${seq}`,
    enabled: true,
    kind: "exact",
    maxDistance: null,
    distance: 0,
    size: keeper.size,
    captureMs: null,
    subsecKnown: false,
    source: null,
    hash: keeper.hash,
    wasted: ordered.reduce((sum, file) => sum + (file.role === "delete" ? file.size : 0), 0),
    files: ordered,
  };
}

export async function searchFiles(options) {
  const started = Date.now();
  const isCancelled = options.isCancelled || (() => false);
  const onProgress = options.onProgress;
  const onGroup = options.onGroup;
  const patterns = compileNamePatterns(options.patterns);
  if (!patterns.list.length) throw new Error("请填写文件名，例如 *.zip 或 *kk*.zip");
  const { roots, nested, invalid } = pruneRoots(options.roots);
  if (!roots.length) {
    throw new Error(invalid.length ? `这些路径不是可用的文件夹：${invalid.join("、")}` : "请先添加要搜索的文件夹");
  }
  const skipDir = (dir) => isExcludedDir(dir, options.excludeDirs || []);
  const stack = [...roots];
  const seen = new Set();
  const errors = [];
  const media = [];
  let dirs = 0;
  let softwareSkipped = 0;
  const progress = {
    phase: "正在查找文件",
    dirs: 0,
    files: 0,
    bytes: 0,
    candidates: 0,
    hashDone: 0,
    hashTotal: 0,
    groups: 0,
    softwareSkipped: 0,
  };
  const emit = () => onProgress?.({ ...progress });
  emit();

  while (stack.length) {
    if (isCancelled()) throw new SearchCancelled();
    const dir = stack.pop();
    const dirKey = dir.toLowerCase();
    if (seen.has(dirKey)) continue;
    seen.add(dirKey);
    if (isSoftwareBoundary(dir) || skipDir(dir)) {
      softwareSkipped += 1;
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (errors.length < 40) errors.push(`${dir}: ${error.message}`);
      continue;
    }
    dirs += 1;
    for (const entry of entries) {
      if ((media.length & 63) === 0 && isCancelled()) throw new SearchCancelled();
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isSoftwareBoundary(full) || skipDir(full)) softwareSkipped += 1;
        else stack.push(full);
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith("._") || !patterns.match(entry.name)) continue;
      let st;
      try {
        st = fs.statSync(full, { bigint: true });
      } catch (error) {
        if (errors.length < 40) errors.push(`${full}: ${error.message}`);
        continue;
      }
      if (!st.isFile() || st.size > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      const pathKey = path.resolve(full).toLowerCase();
      if (seen.has(pathKey)) continue;
      if (st.nlink > 1n) {
        const inoKey = `ino:${st.dev}:${st.ino}`;
        if (seen.has(inoKey)) continue;
        seen.add(inoKey);
      }
      seen.add(pathKey);
      media.push({
        path: full,
        pathKey,
        name: entry.name,
        ext: path.extname(entry.name).toLowerCase(),
        size: Number(st.size),
        mtimeMs: Number(st.mtimeNs / 1_000_000n),
        birthtimeMs: st.birthtimeNs > 0n ? Number(st.birthtimeNs / 1_000_000n) : Number(st.mtimeNs / 1_000_000n),
      });
      progress.files = media.length;
      progress.bytes += Number(st.size);
    }
    if (dirs % 25 === 0) {
      progress.dirs = dirs;
      progress.softwareSkipped = softwareSkipped;
      emit();
    }
  }
  progress.dirs = dirs;
  progress.files = media.length;
  progress.softwareSkipped = softwareSkipped;

  const bySize = new Map();
  for (const file of media) {
    if (!bySize.has(file.size)) bySize.set(file.size, []);
    bySize.get(file.size).push(file);
  }
  const candidates = [...bySize.values()].filter((group) => group.length >= 2).flat();
  progress.candidates = candidates.length;
  progress.hashTotal = candidates.length;
  progress.phase = "正在对比内容";
  emit();

  await mapPool(candidates, 2, async (file) => {
    if (isCancelled()) throw new SearchCancelled();
    try {
      file.hash = await hashFile(file.path, isCancelled);
    } catch (error) {
      if (error instanceof SearchCancelled || error?.name === "SearchCancelled") throw error;
      file.hash = null;
      if (errors.length < 40) errors.push(`${file.path}: ${error.message}`);
    }
    progress.hashDone += 1;
    if (progress.hashDone === candidates.length || progress.hashDone % 5 === 0) emit();
  });
  if (isCancelled()) throw new SearchCancelled();

  const groups = [];
  let seq = 1;
  for (const bucket of bySize.values()) {
    if (bucket.length < 2) continue;
    const byHash = new Map();
    for (const file of bucket) {
      if (!file.hash) continue;
      if (!byHash.has(file.hash)) byHash.set(file.hash, []);
      byHash.get(file.hash).push(file);
    }
    for (const same of byHash.values()) {
      if (same.length < 2) continue;
      const group = makeGroup(same, seq);
      seq += 1;
      groups.push(group);
      progress.groups = groups.length;
      onGroup?.(group);
    }
  }
  progress.phase = "完成";
  emit();
  return {
    files: media.length,
    bytes: progress.bytes,
    candidates: candidates.length,
    groups: groups.length,
    dirs,
    softwareSkipped,
    errors,
    nestedRoots: nested,
    invalidRoots: invalid,
    elapsedMs: Date.now() - started,
  };
}
