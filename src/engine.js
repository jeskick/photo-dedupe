import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isVideoExt } from "./extensions.js";
import { readCapture } from "./metadata.js";
import { clusterByCapture, markOrigins, nameKey, orderForKeep, pregroupKey, withoutCameraPairs } from "./match.js";
import { phashFiles } from "./phash.js";
import { pruneRoots } from "./roots.js";
import { captureBuckets, clusterPhash, hammingHex } from "./similar.js";
import { isPersonalPhotoDir, isSoftwareBoundary, directoryHasProgram } from "./skip.js";

export class ScanCancelled extends Error {
  constructor() {
    super("扫描已停止");
    this.name = "ScanCancelled";
  }
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

function hashFile(filePath, isCancelled, onBytes) {
  return new Promise((resolve, reject) => {
    const hash = createHash("blake2b512");
    const stream = createReadStream(filePath, { highWaterMark: 8 * 1024 * 1024 });
    stream.on("data", (chunk) => {
      if (isCancelled()) {
        stream.destroy(new ScanCancelled());
        return;
      }
      hash.update(chunk);
      onBytes(chunk.length);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function walkMedia(roots, extensions, isCancelled, onFile, onProgress) {
  const stack = [...roots];
  const seen = new Set();
  const errors = [];
  let dirs = 0;
  let files = 0;
  let hardlinksSkipped = 0;
  let softwareSkipped = 0;

  const noteError = (text) => {
    if (errors.length < 40) errors.push(text);
  };

  while (stack.length) {
    if (isCancelled()) return { dirs, files, errors, hardlinksSkipped, softwareSkipped, cancelled: true };
    const dir = stack.pop();
    const dirKey = dir.toLowerCase();
    if (seen.has(dirKey)) continue;
    seen.add(dirKey);
    if (isSoftwareBoundary(dir)) {
      softwareSkipped += 1;
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      noteError(`${dir}: ${error.message}`);
      continue;
    }
    dirs += 1;
    const bundled = directoryHasProgram(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    let skippedBundledFiles = false;
    for (const entry of entries) {
      if ((files & 63) === 0 && isCancelled()) {
        return { dirs, files, errors, hardlinksSkipped, softwareSkipped, cancelled: true };
      }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isSoftwareBoundary(full) || (bundled && !isPersonalPhotoDir(entry.name))) softwareSkipped += 1;
        else stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!extensions.has(ext) || entry.name.startsWith("._")) continue;
      if (bundled) {
        skippedBundledFiles = true;
        continue;
      }
      let st;
      try {
        st = fs.statSync(full, { bigint: true });
      } catch (error) {
        noteError(`${full}: ${error.message}`);
        continue;
      }
      if (!st.isFile() || st.size <= 0n || st.size > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      const pathKey = path.resolve(full).toLowerCase();
      if (seen.has(pathKey)) continue;
      if (st.nlink > 1n) {
        const inoKey = `ino:${st.dev}:${st.ino}`;
        if (seen.has(inoKey)) {
          hardlinksSkipped += 1;
          continue;
        }
        seen.add(inoKey);
      }
      seen.add(pathKey);
      files += 1;
      onFile({
        path: full,
        pathKey,
        name: entry.name,
        ext,
        size: Number(st.size),
        mtimeMs: Number(st.mtimeNs / 1_000_000n),
        birthtimeMs: st.birthtimeNs > 0n ? Number(st.birthtimeNs / 1_000_000n) : Number(st.mtimeNs / 1_000_000n),
      });
      if (files % 250 === 0) onProgress({ dirs, files });
    }
    if (skippedBundledFiles) softwareSkipped += 1;
    if (dirs % 25 === 0) onProgress({ dirs, files });
  }
  onProgress({ dirs, files });
  return { dirs, files, errors, hardlinksSkipped, softwareSkipped, cancelled: false };
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map.values()].filter((group) => group.length >= 2);
}

function publishFile(file, role) {
  return {
    path: file.path,
    pathKey: file.pathKey,
    name: file.name,
    ext: file.ext,
    size: file.size,
    mtimeMs: file.mtimeMs,
    birthtimeMs: file.birthtimeMs ?? null,
    captureMs: file.captureMs ?? null,
    subsecKnown: Boolean(file.subsecKnown),
    source: file.source || null,
    hash: file.hash || null,
    phash: file.phash || null,
    distance: null,
    origin: null,
    originReason: "",
    role,
  };
}

function makeGroup(files, seq, extra = {}) {
  const ordered = markOrigins(orderForKeep(files).map((file, index) => publishFile(file, index === 0 ? "keep" : "delete")));
  const keeper = ordered[0];
  if (keeper.phash) {
    for (const file of ordered) {
      file.distance = file === keeper ? 0 : hammingHex(keeper.phash, file.phash);
    }
  }
  return {
    id: `g${seq}`,
    enabled: true,
    kind: extra.kind || "exact",
    maxDistance: extra.maxDistance ?? null,
    distance: Math.max(0, ...ordered.map((file) => (Number.isFinite(file.distance) ? file.distance : 0))),
    size: keeper.size,
    captureMs: keeper.captureMs,
    subsecKnown: keeper.subsecKnown,
    source: keeper.source,
    hash: keeper.hash,
    wasted: ordered.reduce((sum, file) => sum + (file.role === "delete" ? file.size : 0), 0),
    files: ordered,
  };
}

export async function runScan(options) {
  const started = Date.now();
  const isCancelled = options.isCancelled || (() => false);
  const onProgress = options.onProgress;
  const onGroup = options.onGroup;
  const extensions = options.extensions instanceof Set ? options.extensions : new Set(options.extensions || []);
  if (!extensions.size) throw new Error("请至少选择一种文件类型");

  const nameMode = options.nameMode || "normalized";
  const toleranceSec = Math.min(120, Math.max(0, Number(options.toleranceSec) || 0));
  const matchWithoutTime = options.matchWithoutTime !== false;
  const similar = options.similar === true;
  const requestedDistance = Number(options.similarDistance);
  const maxDistance = Math.min(12, Math.max(0, Number.isFinite(requestedDistance) ? requestedDistance : 4));
  const { roots, nested, invalid } = pruneRoots(options.roots);
  if (!roots.length) {
    throw new Error(invalid.length ? `这些路径不是可用的文件夹：${invalid.join("、")}` : "请先添加要扫描的文件夹");
  }

  const progress = {
    phase: "正在扫描目录",
    dirs: 0,
    files: 0,
    candidates: 0,
    metaDone: 0,
    metaTotal: 0,
    groups: 0,
    hashDone: 0,
    hashTotal: 0,
    hashBytes: 0,
    metaBytes: 0,
    cameraPairsSkipped: 0,
    current: "",
    nestedRoots: nested,
    invalidRoots: invalid,
  };
  const emit = () => onProgress?.({ ...progress, nestedRoots: [...nested], invalidRoots: [...invalid] });
  emit();

  const media = [];
  const walked = walkMedia(roots, extensions, isCancelled, (file) => {
    media.push(file);
    progress.files = media.length;
    progress.current = file.path;
  }, (partial) => {
    progress.dirs = partial.dirs;
    progress.files = partial.files;
    emit();
  });
  progress.dirs = walked.dirs;
  progress.files = walked.files;
  if (walked.cancelled) throw new ScanCancelled();

  const pregroups = groupBy(media, (file) => pregroupKey(file, nameMode));
  const candidates = pregroups.flat();
  progress.candidates = candidates.length;
  progress.metaTotal = candidates.length;
  progress.phase = "正在读取拍摄时间";
  progress.current = "";
  emit();

  let metaThrottle = 0;
  await mapPool(candidates, 8, async (file) => {
    if (isCancelled()) throw new ScanCancelled();
    progress.current = file.path;
    try {
      const result = readCapture(file.path, file.ext, file.size);
      progress.metaBytes += result.bytesRead;
      file.captureMs = result.capture?.captureMs ?? null;
      file.subsecKnown = Boolean(result.capture?.subsecKnown);
      file.source = result.capture?.source || null;
      file.metaLoaded = true;
    } catch (error) {
      file.captureMs = null;
      file.subsecKnown = false;
      file.source = null;
      file.metaLoaded = true;
      if (walked.errors.length < 40) walked.errors.push(`${file.path}: ${error.message}`);
    }
    progress.metaDone += 1;
    const now = Date.now();
    if (now - metaThrottle > 150 || progress.metaDone === progress.metaTotal) {
      metaThrottle = now;
      emit();
    }
  });
  if (isCancelled()) throw new ScanCancelled();

  const timeGroups = [];
  for (const bucket of pregroups) {
    const { groups, missing } = clusterByCapture(bucket, toleranceSec);
    timeGroups.push(...groups);
    if (matchWithoutTime && missing.length >= 2) timeGroups.push(missing);
  }

  const hashTargets = timeGroups.flat();
  progress.hashTotal = hashTargets.length;
  progress.phase = "正在校验文件内容";
  emit();

  const seenHash = new Set();
  const uniqueTargets = [];
  for (const file of hashTargets) {
    if (seenHash.has(file.pathKey)) continue;
    seenHash.add(file.pathKey);
    uniqueTargets.push(file);
  }

  let hashThrottle = 0;
  await mapPool(uniqueTargets, 2, async (file) => {
    if (isCancelled()) throw new ScanCancelled();
    progress.current = file.path;
    try {
      file.hash = await hashFile(file.path, isCancelled, (bytes) => {
        progress.hashBytes += bytes;
      });
    } catch (error) {
      if (error?.name === "ScanCancelled") throw error;
      file.hash = null;
      if (walked.errors.length < 40) walked.errors.push(`${file.path}: ${error.message}`);
    }
    progress.hashDone += 1;
    const now = Date.now();
    if (now - hashThrottle > 200 || progress.hashDone === uniqueTargets.length) {
      hashThrottle = now;
      emit();
    }
  });
  if (isCancelled()) throw new ScanCancelled();

  const confirmed = [];
  let seq = 1;
  for (const bucket of timeGroups) {
    const byHash = new Map();
    for (const file of bucket) {
      if (!file.hash) continue;
      if (!byHash.has(file.hash)) byHash.set(file.hash, []);
      byHash.get(file.hash).push(file);
    }
    for (const same of byHash.values()) {
      if (same.length < 2) continue;
      const group = makeGroup(same, seq, { kind: "exact" });
      seq += 1;
      confirmed.push(group);
      progress.groups = confirmed.length;
      onGroup?.(group);
    }
  }

  if (similar) {
    const images = media.filter((file) => !isVideoExt(file.ext));
    const unread = images.filter((file) => !file.metaLoaded);
    progress.metaTotal += unread.length;
    progress.phase = "正在读取拍摄时间";
    await mapPool(unread, 8, async (file) => {
      if (isCancelled()) throw new ScanCancelled();
      progress.current = file.path;
      try {
        const result = readCapture(file.path, file.ext, file.size);
        progress.metaBytes += result.bytesRead;
        file.captureMs = result.capture?.captureMs ?? null;
        file.subsecKnown = Boolean(result.capture?.subsecKnown);
        file.source = result.capture?.source || null;
      } catch (error) {
        file.captureMs = null;
        if (walked.errors.length < 40) walked.errors.push(`${file.path}: ${error.message}`);
      }
      file.metaLoaded = true;
      progress.metaDone += 1;
      emit();
    });
    if (isCancelled()) throw new ScanCancelled();

    const buckets = captureBuckets(images, toleranceSec);
    if (matchWithoutTime) {
      const missing = images.filter((file) => file.captureMs == null);
      const nameModeForMissing = nameMode === "ignore" ? "normalized" : nameMode;
      buckets.push(...groupBy(missing, (file) => nameKey(file.name, nameModeForMissing)));
    }
    const seenPhash = new Set();
    const phashTargets = [];
    for (const bucket of buckets) {
      for (const file of bucket) {
        if (seenPhash.has(file.pathKey)) continue;
        seenPhash.add(file.pathKey);
        phashTargets.push(file);
      }
    }
    progress.phase = "正在比对画面";
    progress.hashDone = 0;
    progress.hashTotal = phashTargets.length;
    emit();
    let fingerprints = new Map();
    if (phashTargets.length) {
      try {
        fingerprints = await phashFiles(phashTargets.map((file) => file.path), {
          isCancelled,
          onItem: () => {
            progress.hashDone += 1;
            emit();
          },
        });
      } catch (error) {
        if (error?.name === "ScanCancelled") throw error;
        progress.similarError = error.message || "画面比对失败";
        if (walked.errors.length < 40) walked.errors.push(progress.similarError);
      }
    }
    if (isCancelled()) throw new ScanCancelled();
    for (const file of phashTargets) file.phash = fingerprints.get(file.path) || null;

    const claimed = new Map();
    for (const group of confirmed) {
      for (const file of group.files) claimed.set(file.pathKey, group);
    }
    const mediaByKey = new Map(media.map((file) => [file.pathKey, file]));
    for (const bucket of buckets) {
      for (const cluster of clusterPhash(bucket, maxDistance)) {
        const parts = withoutCameraPairs(cluster);
        progress.cameraPairsSkipped += cluster.length - parts.reduce((sum, part) => sum + part.length, 0);
        for (const part of parts) {
        const fresh = part.filter((file) => !claimed.has(file.pathKey));
        const anchors = [...new Set(part.map((file) => claimed.get(file.pathKey)).filter(Boolean))];
        if (!fresh.length) continue;
        if (anchors.length === 1) {
          const group = anchors[0];
          const keep = group.files.find((file) => file.role === "keep") || group.files[0];
          const keepMedia = mediaByKey.get(keep.pathKey);
          if (keepMedia?.phash) keep.phash = keepMedia.phash;
          let added = 0;
          for (const file of fresh) {
            const published = publishFile(file, "delete");
            published.distance = keep.phash ? hammingHex(keep.phash, file.phash) : null;
            group.files.push(published);
            claimed.set(file.pathKey, group);
            added += 1;
          }
          if (!added) continue;
          markOrigins(group.files);
          group.kind = "similar";
          group.maxDistance = maxDistance;
          group.distance = Math.max(0, ...group.files.map((file) => (Number.isFinite(file.distance) ? file.distance : 0)));
          group.wasted = group.files.reduce((sum, file) => sum + (file.role === "delete" ? file.size : 0), 0);
          onGroup?.(group);
          continue;
        }
        if (anchors.length > 1 && fresh.length < 2) continue;
        const members = anchors.length > 1 ? fresh : part;
        const group = makeGroup(members, seq, { kind: "similar", maxDistance });
        seq += 1;
        confirmed.push(group);
        for (const file of group.files) claimed.set(file.pathKey, group);
        progress.groups = confirmed.length;
        onGroup?.(group);
        }
      }
    }
  }

  progress.phase = "完成";
  progress.current = "";
  emit();

  const deletableFiles = confirmed.reduce((sum, group) => sum + group.files.filter((file) => file.role === "delete").length, 0);
  const wastedBytes = confirmed.reduce((sum, group) => sum + group.wasted, 0);
  return {
    filesScanned: walked.files,
    dirs: walked.dirs,
    candidates: candidates.length,
    groups: confirmed.length,
    deletableFiles,
    wastedBytes,
    errors: walked.errors,
    hardlinksSkipped: walked.hardlinksSkipped,
    softwareSkipped: walked.softwareSkipped,
    cameraPairsSkipped: progress.cameraPairsSkipped,
    nestedRoots: nested,
    invalidRoots: invalid,
    similarError: progress.similarError || null,
    elapsedMs: Date.now() - started,
    metaBytes: progress.metaBytes,
    hashBytes: progress.hashBytes,
    cancelled: false,
    found: confirmed,
  };
}
