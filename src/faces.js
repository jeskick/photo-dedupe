export const SAME_PERSON = 0.24;

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

export function bestPerson(embedding, people, threshold = SAME_PERSON) {
  let found = null;
  let score = threshold;
  for (const person of people || []) {
    if (!person.embedding) continue;
    const value = cosine(embedding, person.embedding);
    if (value >= score) {
      score = value;
      found = person;
    }
  }
  return found;
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

export function clusterPeople(faces, { largeAt = 8, high = 0.4, low = 0.2 } = {}) {
  const clusters = faces.map((face) => ({
    members: [face],
    sum: Float64Array.from(face.embedding),
    center: Float32Array.from(face.embedding),
  }));
  const alive = clusters.map((_, index) => index);
  while (alive.length > 1) {
    let best = -1;
    let left = -1;
    let right = -1;
    for (let a = 0; a < alive.length; a += 1) {
      for (let b = a + 1; b < alive.length; b += 1) {
        const first = clusters[alive[a]];
        const second = clusters[alive[b]];
        const value = cosine(first.center, second.center);
        const need = Math.min(first.members.length, second.members.length) >= largeAt ? high : low;
        if (value >= need && value > best) {
          best = value;
          left = a;
          right = b;
        }
      }
    }
    if (left < 0) break;
    const first = clusters[alive[left]];
    const second = clusters[alive[right]];
    for (let index = 0; index < first.sum.length; index += 1) first.sum[index] += second.sum[index];
    first.members.push(...second.members);
    const count = first.members.length;
    let norm = 0;
    for (let index = 0; index < first.sum.length; index += 1) norm += (first.sum[index] / count) ** 2;
    norm = Math.sqrt(norm) || 1;
    first.center = new Float32Array(first.sum.length);
    for (let index = 0; index < first.sum.length; index += 1) first.center[index] = (first.sum[index] / count) / norm;
    alive.splice(right, 1);
  }
  return alive.map((index) => clusters[index]);
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
