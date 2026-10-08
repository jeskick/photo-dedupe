import { parentPort, workerData } from "node:worker_threads";
import { catalogFiles } from "./library-scan.js";

const flag = new Int32Array(workerData.sab);
let batch = [];

function emitBatch() {
  if (!batch.length) return;
  const files = batch;
  batch = [];
  parentPort.postMessage({ type: "batch", files });
}

try {
  const result = catalogFiles(workerData.roots, {
    isCancelled: () => Atomics.load(flag, 0) !== 0,
    onFile: (file) => {
      batch.push(file);
      if (batch.length >= 200) emitBatch();
    },
    onProgress: (progress) => parentPort.postMessage({ type: "progress", progress }),
  });
  emitBatch();
  parentPort.postMessage({
    type: result.cancelled ? "cancelled" : "done",
    summary: {
      dirs: result.dirs,
      files: result.files,
      softwareSkipped: result.softwareSkipped,
      cancelled: result.cancelled,
    },
  });
} catch (error) {
  emitBatch();
  parentPort.postMessage({ type: "failed", message: error?.message || String(error) });
}
