import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { SIDECAR_EXTS } from "./extensions.js";
import { phashFiles } from "./phash.js";
import { recyclePaths } from "./picker.js";
import { hammingHex } from "./similar.js";

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("blake2b512");
    const stream = createReadStream(filePath, { highWaterMark: 8 * 1024 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sidecarsOf(filePath) {
  const dir = path.dirname(filePath);
  const stem = path.parse(filePath).name.toLowerCase();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SIDECAR_EXTS.includes(ext)) continue;
    if (path.parse(entry.name).name.toLowerCase() !== stem) continue;
    found.push(path.join(dir, entry.name));
  }
  return found;
}

export async function planDeletions(job, { includeSidecars = true } = {}) {
  const deletions = [];
  const skipped = [];
  const pending = [];
  for (const group of job.groups) {
    if (!group.enabled) continue;
    const keepers = group.files.filter((file) => file.role === "keep");
    if (keepers.length !== 1) {
      skipped.push({ path: group.files[0]?.path || group.id, error: "这一组没有唯一的保留文件，已跳过" });
      continue;
    }
    const keep = keepers[0];
    let keepStat;
    try {
      keepStat = fs.statSync(keep.path);
    } catch {
      skipped.push({ path: keep.path, error: "保留文件已经不在原处，这一组未删除" });
      continue;
    }
    if (!keepStat.isFile() || keepStat.size !== keep.size) {
      skipped.push({ path: keep.path, error: "保留文件已变化，这一组未删除" });
      continue;
    }
    for (const file of group.files) {
      if (file.role !== "delete") continue;
      if (file.pathKey === keep.pathKey) {
        skipped.push({ path: file.path, error: "不能删除要保留的文件" });
        continue;
      }
      let st;
      try {
        st = fs.statSync(file.path);
      } catch {
        skipped.push({ path: file.path, error: "文件已经不在原处" });
        continue;
      }
      if (!st.isFile() || st.size !== file.size) {
        skipped.push({ path: file.path, error: "文件大小已变化，未删除" });
        continue;
      }
      if (Math.abs(st.mtimeMs - file.mtimeMs) > 2 && file.hash && keep.hash && file.hash === keep.hash) {
        try {
          const hash = await hashFile(file.path);
          if (hash !== keep.hash) {
            skipped.push({ path: file.path, error: "文件内容已变化，未删除" });
            continue;
          }
        } catch (error) {
          skipped.push({ path: file.path, error: `无法重新校验：${error.message}` });
          continue;
        }
      }
      const sameBytes = Boolean(file.hash && keep.hash && file.hash === keep.hash);
      if (!sameBytes) {
        if (group.kind !== "similar" || group.maxDistance == null) {
          skipped.push({ path: file.path, error: "无法确认这份文件和保留文件相同，未删除" });
          continue;
        }
        pending.push({ file, keep, group });
        continue;
      }
      deletions.push({
        path: file.path,
        pathKey: file.pathKey,
        size: file.size,
        groupId: group.id,
        sidecars: includeSidecars ? sidecarsOf(file.path) : [],
      });
    }
  }
  if (pending.length) {
    const paths = [...new Set(pending.flatMap((item) => [item.file.path, item.keep.path]))];
    let hashes = new Map();
    try {
      hashes = await phashFiles(paths);
    } catch (error) {
      for (const item of pending) {
        skipped.push({ path: item.file.path, error: `无法重新比对画面：${error.message}` });
      }
      return { deletions, skipped };
    }
    for (const item of pending) {
      const distance = hammingHex(hashes.get(item.keep.path), hashes.get(item.file.path));
      if (distance <= item.group.maxDistance) {
        deletions.push({
          path: item.file.path,
          pathKey: item.file.pathKey,
          size: item.file.size,
          groupId: item.group.id,
          sidecars: includeSidecars ? sidecarsOf(item.file.path) : [],
        });
      } else {
        skipped.push({ path: item.file.path, error: "画面已经对不上，未删除" });
      }
    }
  }
  return { deletions, skipped };
}

export async function applyDeletions(job, options = {}) {
  const { deletions, skipped } = await planDeletions(job, options);
  if (!deletions.length) return { deleted: [], sidecars: [], skipped, freedBytes: 0 };
  const results = await recyclePaths(deletions.map((item) => item.path));
  const byPath = new Map(results.map((item) => [String(item.path).toLowerCase(), item]));
  const deleted = [];
  const failed = [];
  for (const item of deletions) {
    const result = byPath.get(item.path.toLowerCase());
    if (result?.ok) deleted.push(item);
    else failed.push({ path: item.path, error: result?.error || "移入回收站失败" });
  }
  const deletedKeys = new Set(deleted.map((item) => item.pathKey));
  const freedBytes = deleted.reduce((sum, item) => sum + item.size, 0);
  for (const group of job.groups) {
    group.files = group.files.filter((file) => !deletedKeys.has(file.pathKey));
    group.wasted = group.files.reduce((sum, file) => sum + (file.role === "delete" ? file.size : 0), 0);
    if (!group.files.some((file) => file.role === "keep") && group.files.length) {
      group.files[0].role = "keep";
      for (let i = 1; i < group.files.length; i += 1) {
        if (group.files[i].role === "keep") group.files[i].role = "delete";
      }
    }
  }
  job.groups = job.groups.filter((group) => group.files.length >= 2);
  job.fileIndex = new Map();
  for (const group of job.groups) {
    for (const file of group.files) job.fileIndex.set(file.pathKey, file);
  }

  const sidecarPaths = [...new Set(deleted.flatMap((item) => item.sidecars))];
  let sidecars = [];
  if (sidecarPaths.length) {
    const sidecarResults = await recyclePaths(sidecarPaths);
    sidecars = sidecarResults;
  }
  return { deleted, sidecars, skipped: skipped.concat(failed), freedBytes };
}
