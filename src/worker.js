import { parentPort, workerData } from "node:worker_threads";
import { runScan, ScanCancelled } from "./engine.js";

const flag = new Int32Array(workerData.sab);

try {
  const result = await runScan({
    roots: workerData.roots,
    extensions: new Set(workerData.extensions),
    nameMode: workerData.nameMode,
    toleranceSec: workerData.toleranceSec,
    matchWithoutTime: workerData.matchWithoutTime,
    similar: workerData.similar,
    similarDistance: workerData.similarDistance,
    excludeDirs: workerData.excludeDirs || [],
    minEdgePhoto: workerData.minEdgePhoto || 0,
    minEdgeVideo: workerData.minEdgeVideo || 0,
    isCancelled: () => Atomics.load(flag, 0) !== 0,
    onProgress: (progress) => parentPort.postMessage({ type: "progress", progress }),
    onGroup: (group) => parentPort.postMessage({ type: "group", group }),
  });
  const { found, ...summary } = result;
  parentPort.postMessage({ type: "done", summary });
} catch (error) {
  if (error instanceof ScanCancelled || error?.name === "ScanCancelled") {
    parentPort.postMessage({ type: "cancelled" });
  } else {
    parentPort.postMessage({ type: "failed", message: error?.message || String(error) });
  }
}
