export const SAME_PERSON = 0.45;

export function cosine(left, right) {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function bestName(embedding, named, threshold = SAME_PERSON) {
  let name = "";
  let score = threshold;
  for (const face of named || []) {
    if (!face.name) continue;
    const value = cosine(embedding, face.embedding);
    if (value >= score) {
      score = value;
      name = face.name;
    }
  }
  return name;
}

export function facesToRename(target, faces, name, threshold = SAME_PERSON) {
  const next = String(name || "").trim();
  if (!next) return [{ id: target.id, name: "" }];
  const updates = [];
  for (const face of faces) {
    if (face.id === target.id || cosine(target.embedding, face.embedding) >= threshold) {
      updates.push({ id: face.id, name: next });
    }
  }
  return updates;
}

export function embeddingFromBuffer(blob) {
  const copy = Buffer.from(blob);
  const aligned = new ArrayBuffer(copy.byteLength);
  new Uint8Array(aligned).set(copy);
  return new Float32Array(aligned);
}

export function bufferFromEmbedding(embedding) {
  const values = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding || []);
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}
