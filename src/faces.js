export const SAME_PERSON = 0.32;
export const FACE_MODEL = "buffalo_l";

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

export function mainSubjects(faces, threshold = SAME_PERSON) {
  const ranked = (faces || [])
    .map((face) => ({ embedding: face.embedding, area: Number(face.area) || 0 }))
    .filter((face) => face.embedding?.length)
    .sort((left, right) => right.area - left.area);
  const kept = [];
  for (const face of ranked) {
    if (kept.some((item) => cosine(face.embedding, item.embedding) >= threshold)) continue;
    kept.push(face);
  }
  return kept;
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

function recenter(cluster) {
  const count = cluster.members.length;
  let norm = 0;
  for (let index = 0; index < cluster.sum.length; index += 1) norm += (cluster.sum[index] / count) ** 2;
  norm = Math.sqrt(norm) || 1;
  cluster.center = new Float32Array(cluster.sum.length);
  for (let index = 0; index < cluster.sum.length; index += 1) cluster.center[index] = (cluster.sum[index] / count) / norm;
}

function absorb(cluster, face) {
  const values = face.embedding;
  for (let index = 0; index < cluster.sum.length; index += 1) cluster.sum[index] += values[index];
  cluster.members.push(face);
  recenter(cluster);
}

export function clusterPeople(faces, { largeAt = 80, high = 0.5, low = 0.32, floor = 0.48 } = {}) {
  const clusters = [];
  for (const face of faces) {
    let best = -1;
    let chosen = -1;
    for (let index = 0; index < clusters.length; index += 1) {
      const value = cosine(face.embedding, clusters[index].center);
      const need = clusters[index].members.length >= largeAt ? high : low;
      if (value >= need && value > best) {
        best = value;
        chosen = index;
      }
    }
    if (chosen < 0) {
      clusters.push({
        members: [face],
        sum: Float64Array.from(face.embedding),
        center: Float32Array.from(face.embedding),
      });
    } else absorb(clusters[chosen], face);
  }
  let merged = true;
  while (merged && clusters.length > 1) {
    merged = false;
    let best = -1;
    let left = -1;
    let right = -1;
    for (let a = 0; a < clusters.length; a += 1) {
      for (let b = a + 1; b < clusters.length; b += 1) {
        const value = cosine(clusters[a].center, clusters[b].center);
        const need = Math.max(clusters[a].members.length, clusters[b].members.length) >= largeAt ? high : low;
        if (value >= need && value > best) {
          best = value;
          left = a;
          right = b;
        }
      }
    }
    if (left < 0) break;
    const first = clusters[left];
    const second = clusters[right];
    for (let index = 0; index < first.sum.length; index += 1) first.sum[index] += second.sum[index];
    first.members.push(...second.members);
    recenter(first);
    clusters.splice(right, 1);
    merged = true;
  }
  if (floor > 0) {
    const loose = [];
    for (let index = clusters.length - 1; index >= 0; index -= 1) {
      const cluster = clusters[index];
      if (cluster.members.length < 8) continue;
      const stay = cluster.members.filter((face) => cosine(face.embedding, cluster.center) >= floor);
      if (stay.length === cluster.members.length) continue;
      loose.push(...cluster.members.filter((face) => cosine(face.embedding, cluster.center) < floor));
      if (!stay.length) {
        clusters.splice(index, 1);
        continue;
      }
      cluster.members = stay;
      cluster.sum = new Float64Array(stay[0].embedding.length);
      for (const face of stay) {
        for (let dim = 0; dim < cluster.sum.length; dim += 1) cluster.sum[dim] += face.embedding[dim];
      }
      recenter(cluster);
    }
    if (loose.length) clusters.push(...clusterPeople(loose, { largeAt, high: Math.max(high, floor), low: floor, floor: 0 }));
  }
  return clusters.filter((cluster) => cluster.members.length);
}

function firstAtOrAfter(shots, time) {
  let low = 0;
  let high = shots.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (shots[mid].captureMs < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function linkBackViews(shots, windowMs = 4 * 60 * 60 * 1000) {
  const faced = shots.filter((shot) => shot.personIds?.length).sort((left, right) => left.captureMs - right.captureMs);
  const linked = [];
  for (const shot of shots) {
    if (!shot.body || shot.personIds?.length) continue;
    const counts = new Map();
    const start = firstAtOrAfter(faced, shot.captureMs - windowMs);
    for (let index = start; index < faced.length && faced[index].captureMs <= shot.captureMs + windowMs; index += 1) {
      for (const personId of new Set(faced[index].personIds)) counts.set(personId, (counts.get(personId) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
    if (!ranked.length) continue;
    const [personId, count] = ranked[0];
    const total = ranked.reduce((sum, item) => sum + item[1], 0);
    const faceless = shots.filter((item) => item.body && !item.personIds?.length && Math.abs(item.captureMs - shot.captureMs) <= windowMs).length;
    if (faceless > count) continue;
    if (ranked.length === 1 || (count >= 2 && count / total >= 0.8)) linked.push({ path: shot.path, personId });
  }
  return linked;
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
