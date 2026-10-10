import fs from "node:fs";
import path from "node:path";
import { isExcludedDir } from "./library-scan.js";
import { compileNamePatterns } from "./patterns.js";
import { pruneRoots } from "./roots.js";
import { isSoftwareBoundary } from "./skip.js";

export const SEARCH_LIST_CAP = 3000;

export class SearchCancelled extends Error {
  constructor() {
    super("搜索已停止");
    this.name = "SearchCancelled";
  }
}

export function searchFiles(options) {
  const started = Date.now();
  const isCancelled = options.isCancelled || (() => false);
  const onProgress = options.onProgress;
  const onFile = options.onFile;
  const patterns = compileNamePatterns(options.patterns);
  if (!patterns.list.length) throw new Error("请填写文件名，例如 *.zip 或 *kk*.pdf");
  const { roots, nested, invalid } = pruneRoots(options.roots);
  if (!roots.length) {
    throw new Error(invalid.length ? `这些路径不是可用的文件夹：${invalid.join("、")}` : "请先添加要搜索的文件夹");
  }
  const skipDir = (dir) => isExcludedDir(dir, options.excludeDirs || []);
  const stack = [...roots];
  const seen = new Set();
  const errors = [];
  let dirs = 0;
  let files = 0;
  let bytes = 0;
  let listed = 0;
  let softwareSkipped = 0;

  const progress = () => onProgress?.({
    phase: "正在搜索文件",
    dirs,
    files,
    bytes,
    listed,
    softwareSkipped,
    current: "",
  });
  progress();

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
      if ((files & 63) === 0 && isCancelled()) throw new SearchCancelled();
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
      const file = {
        path: full,
        name: entry.name,
        ext: path.extname(entry.name).toLowerCase(),
        size: Number(st.size),
      };
      files += 1;
      bytes += file.size;
      if (listed < SEARCH_LIST_CAP) {
        listed += 1;
        onFile?.(file);
      }
    }
    if (dirs % 25 === 0) progress();
  }
  progress();
  return {
    files,
    bytes,
    listed,
    dirs,
    softwareSkipped,
    errors,
    nestedRoots: nested,
    invalidRoots: invalid,
    elapsedMs: Date.now() - started,
    truncated: files > listed,
  };
}
