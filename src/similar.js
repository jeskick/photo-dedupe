export function hammingHex(left, right) {
  if (!left || !right || left.length !== right.length || !/^[0-9a-f]+$/i.test(left + right)) return Number.POSITIVE_INFINITY;
  let bits = 0;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  while (value) {
    bits += Number(value & 1n);
    value >>= 1n;
  }
  return bits;
}

/** 按拍摄时间分桶，窗口从桶的起点算，避免一整次拍摄被连成一组。 */
export function captureBuckets(files, toleranceSec) {
  const tolerance = Math.max(0, Math.round(Number(toleranceSec) || 0));
  const timed = files
    .filter((file) => file.captureMs != null)
    .sort((a, b) => a.captureMs - b.captureMs || a.path.localeCompare(b.path));
  const buckets = [];
  let current = [];
  let startSec = 0;
  for (const file of timed) {
    const second = Math.floor(file.captureMs / 1000);
    if (!current.length || second - startSec <= tolerance) {
      if (!current.length) startSec = second;
      current.push(file);
    } else {
      if (current.length >= 2) buckets.push(current);
      current = [file];
      startSec = second;
    }
  }
  if (current.length >= 2) buckets.push(current);
  return buckets;
}

/** 一组里每两张都要足够接近，避免连拍被接力串成同一组。 */
export function clusterPhash(files, maxDistance) {
  const groups = [];
  const ordered = [...files].filter((file) => file.phash).sort((a, b) => a.path.localeCompare(b.path));
  for (const file of ordered) {
    let placed = false;
    for (const group of groups) {
      if (group.every((other) => hammingHex(other.phash, file.phash) <= maxDistance)) {
        group.push(file);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([file]);
  }
  return groups.filter((group) => group.length >= 2);
}
