import { parentPort, workerData } from "node:worker_threads";
import { searchFiles, SearchCancelled } from "./search.js";

const flag = new Int32Array(workerData.sab);

try {
  const result = await searchFiles({
    roots: workerData.roots,
    patterns: workerData.patterns,
    excludeDirs: workerData.excludeDirs || [],
    isCancelled: () => Atomics.load(flag, 0) !== 0,
    onProgress: (progress) => parentPort.postMessage({ type: "progress", progress }),
    onGroup: (group) => parentPort.postMessage({ type: "group", group }),
  });
  parentPort.postMessage({ type: "done", summary: result });
} catch (error) {
  if (error instanceof SearchCancelled || error?.name === "SearchCancelled") {
    parentPort.postMessage({ type: "cancelled" });
  } else {
    parentPort.postMessage({ type: "failed", message: error?.message || String(error) });
  }
}
