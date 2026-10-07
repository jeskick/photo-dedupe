import path from "node:path";
import { familyOf } from "./extensions.js";
import { exactKey, isCopyName, normalizeKey } from "./filename.js";

export function nameKey(filename, mode) {
  if (mode === "exact") return exactKey(filename);
  if (mode === "ignore") return "";
  return normalizeKey(filename);
}

export function pregroupKey(file, mode) {
  return `${file.size}\0${familyOf(file.ext)}\0${nameKey(file.name, mode)}`;
}

export function sameCapture(a, b, toleranceSec) {
  if (a.captureMs == null || b.captureMs == null) return false;
  const tolMs = Math.max(0, Number(toleranceSec) || 0) * 1000;
  if (a.subsecKnown && b.subsecKnown) return Math.abs(a.captureMs - b.captureMs) <= tolMs;
  const tolSec = Math.max(0, Math.round((Number(toleranceSec) || 0)));
  return Math.abs(Math.floor(a.captureMs / 1000) - Math.floor(b.captureMs / 1000)) <= tolSec;
}

function clusterPairwise(files, toleranceSec) {
  const parent = files.map((_, index) => index);
  const find = (index) => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]];
      cursor = parent[cursor];
    }
    return cursor;
  };
  const order = files.map((file, index) => ({ file, index })).sort((a, b) => a.file.captureMs - b.file.captureMs);
  const tolMs = Math.max(0, Number(toleranceSec) || 0) * 1000;
  const maxGap = Math.max(tolMs, ((Number(toleranceSec) || 0) + 1) * 1000);
  for (let i = 0; i < order.length; i += 1) {
    for (let j = i - 1; j >= 0; j -= 1) {
      if (order[i].file.captureMs - order[j].file.captureMs > maxGap) break;
      if (sameCapture(order[i].file, order[j].file, toleranceSec)) {
        parent[find(order[i].index)] = find(order[j].index);
      }
    }
  }
  const buckets = new Map();
  files.forEach((file, index) => {
    const root = find(index);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(file);
  });
  return [...buckets.values()];
}

/** 有亚秒的照片按精确时间分组；没有亚秒的只在不会把两次不同拍摄连起来时并入。 */
export function clusterByCapture(files, toleranceSec) {
  const missing = [];
  const known = [];
  const loose = [];
  for (const file of files) {
    if (file.captureMs == null) missing.push(file);
    else if (file.subsecKnown) known.push(file);
    else loose.push(file);
  }
  const knownGroups = clusterPairwise(known, toleranceSec);
  const attached = new Set();
  for (const file of loose) {
    const hits = knownGroups.filter((group) => group.every((item) => sameCapture(item, file, toleranceSec)));
    if (hits.length === 1) {
      hits[0].push(file);
      attached.add(file);
    }
  }
  const rest = loose.filter((file) => !attached.has(file));
  const groups = [...knownGroups, ...clusterPairwise(rest, toleranceSec)].filter((group) => group.length >= 2);
  return { groups, missing };
}

export function keepRank(file) {
  const stem = path.parse(file.name).name.toLocaleLowerCase("en-US");
  const originalName = stem === normalizeKey(file.name) ? 1 : 0;
  return [originalName, -file.path.length, -file.mtimeMs];
}

function appearedAt(file) {
  const birth = Number(file.birthtimeMs);
  if (Number.isFinite(birth) && birth > 0) return birth;
  const modified = Number(file.mtimeMs);
  return Number.isFinite(modified) ? modified : 0;
}

/** 标出这组里更像拍摄原件的一份，以及后来复制出来的文件。 */
export function markOrigins(files) {
  if (!files.length) return files;
  const ranked = [...files].sort((a, b) => {
    const nameDelta = (isCopyName(a.name) ? 1 : 0) - (isCopyName(b.name) ? 1 : 0);
    if (nameDelta) return nameDelta;
    const timeDelta = appearedAt(a) - appearedAt(b);
    if (timeDelta) return timeDelta;
    const pathDelta = String(a.path).length - String(b.path).length;
    if (pathDelta) return pathDelta;
    return String(a.path).localeCompare(String(b.path), "en");
  });
  const original = ranked[0];
  const originalTime = appearedAt(original);
  for (const file of files) {
    if (file === original) {
      file.origin = "original";
      file.originReason = isCopyName(file.name) ? "这组里最早出现的文件" : "文件名没有副本标记，也是更早的一份";
      continue;
    }
    if (isCopyName(file.name)) {
      file.origin = "copy";
      file.originReason = "文件名带有副本、(1) 或 copy";
      continue;
    }
    if (appearedAt(file) >= originalTime + 2000) {
      file.origin = "copy";
      file.originReason = "文件创建时间更晚，是后来复制的";
      continue;
    }
    file.origin = "same";
    file.originReason = "文件名和创建时间都接近，看不出先后";
  }
  return files;
}

export function orderForKeep(files) {
  return [...files].sort((a, b) => {
    const left = keepRank(a);
    const right = keepRank(b);
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return right[i] - left[i];
    }
    return a.path.localeCompare(b.path, "en");
  });
}
