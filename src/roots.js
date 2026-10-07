import fs from "node:fs";
import path from "node:path";

function stripTrailingSep(value) {
  return value.replace(/[\\/]+$/, "");
}

/** 去掉重复路径，以及已经包含在其他所选目录里的子目录。 */
export function pruneRoots(inputs) {
  const resolved = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of inputs || []) {
    const text = String(raw || "").trim().replace(/^"(.*)"$/, "$1");
    if (!text) continue;
    const abs = path.resolve(text);
    const key = stripTrailingSep(abs).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      invalid.push(abs);
      continue;
    }
    if (!st.isDirectory()) {
      invalid.push(abs);
      continue;
    }
    resolved.push(abs);
  }

  resolved.sort((a, b) => a.length - b.length);
  const kept = [];
  const nested = [];
  for (const abs of resolved) {
    const low = stripTrailingSep(abs).toLowerCase();
    const parent = kept.find((item) => low === item.low || low.startsWith(`${item.low}\\`));
    if (parent) nested.push(abs);
    else kept.push({ path: abs, low });
  }
  return {
    roots: kept.map((item) => item.path),
    nested,
    invalid,
  };
}
