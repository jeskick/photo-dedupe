import { parentPort, workerData } from "node:worker_threads";
import { searchFiles, SearchCancelled } from "./search.js";

const flag = new Int32Array(workerData.sab);

try {
  const result = searchFiles({
    roots: workerData.roots,
    patterns: workerData.patterns,
    excludeDirs: workerData.excludeDirs || [],
    isCancelled: () => Atomics.load(flag, 0) !== 0,
    onProgress: (progress) => parentPort.postMessage({ type: "progress", progress }),
    onFile: (file) => parentPort.postMessage({ type: "file", file }),
  });
  parentPort.postMessage({ type: "done", summary: result });
} catch (error) {
  if (error instanceof SearchCancelled || error?.name === "SearchCancelled") {
    parentPort.postMessage({ type: "cancelled" });
  } else {
    parentPort.postMessage({ type: "failed", message: error?.message || String(error) });
  }
}
