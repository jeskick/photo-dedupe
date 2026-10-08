const treeEl = document.querySelector("#tree");
const mosaicEl = document.querySelector("#mosaic");
const stageEl = document.querySelector("#stage");
const countEl = document.querySelector("#count");
const statusEl = document.querySelector("#scan-status");
const searchEl = document.querySelector("#search");
const scanBtn = document.querySelector("#scan");
const stopBtn = document.querySelector("#stop");
const viewer = document.querySelector("#viewer");
const viewerImg = document.querySelector("#viewer-img");
const viewerCaption = document.querySelector("#viewer-caption");
const scrubEl = document.querySelector("#scrub");
const scrubTrack = document.querySelector("#scrub-track");
const scrubLabel = document.querySelector("#scrub-label");
let scrubTimer = 0;
let scrollLock = 0;
let dragOrigin = null;
let blockScrubClick = false;
let pendingMark = null;
let scrubSeekTimer = 0;
let loadGen = 0;

const state = {
  days: [],
  photos: [],
  offset: 0,
  year: "",
  month: "",
  day: "",
  q: "",
  loading: false,
  done: false,
  open: -1,
  scanning: false,
};

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function monthName(month) {
  return `${Number(month)}月`;
}

function dateText(photo) {
  if (!photo) return "";
  return `${photo.year}年${photo.month}月${photo.day}日`;
}

function nest(days) {
  const years = [];
  for (const row of days) {
    let year = years.find((item) => item.year === row.year);
    if (!year) {
      year = { year: row.year, count: 0, months: [] };
      years.push(year);
    }
    year.count += row.count;
    let month = year.months.find((item) => item.month === row.month);
    if (!month) {
      month = { month: row.month, count: 0, days: [] };
      year.months.push(month);
    }
    month.count += row.count;
    month.days.push(row);
  }
  return years;
}

function renderScrub() {
  const years = nest(state.days);
  scrubTrack.replaceChildren();
  if (years.length < 2 && years.reduce((sum, year) => sum + year.months.length, 0) < 2) {
    scrubEl.classList.remove("show");
    return;
  }
  years.forEach((year, index) => {
    const span = Math.max(1, years.length - 1);
    const top = years.length === 1 ? 50 : (index / span) * 100;
    const button = h("button", { class: "scrub-year", type: "button", text: String(year.year) });
    button.dataset.year = String(year.year);
    button.style.top = `${top}%`;
    button.addEventListener("click", () => jumpYear(year.year));
    scrubTrack.append(button);
    if (index === years.length - 1) return;
    const mark = h("button", { class: "scrub-dot", type: "button" });
    mark.style.top = `${(index + 0.5) / span * 100}%`;
    mark.setAttribute("aria-label", `${year.year}年`);
    mark.addEventListener("click", () => jumpYear(year.year));
    scrubTrack.append(mark);
  });
}

function visibleMonth() {
  const edge = stageEl.getBoundingClientRect().top + 28;
  const sections = [...mosaicEl.querySelectorAll(".photo-month")];
  let current = sections[0] || null;
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= edge) current = section;
  }
  return current;
}

function placeScrubLabel() {
  if (scrubEl.classList.contains("dragging")) return;
  const section = visibleMonth();
  if (!section) {
    scrubLabel.hidden = true;
    return;
  }
  const year = section.dataset.year;
  const month = section.dataset.month;
  for (const button of scrubTrack.querySelectorAll(".scrub-year")) {
    button.classList.toggle("on", button.dataset.year === year);
  }
  const active = scrubTrack.querySelector(`.scrub-year[data-year="${year}"]`);
  scrubLabel.hidden = false;
  scrubLabel.textContent = `${year}年${Number(month)}月`;
  if (active) {
    const rail = scrubEl.getBoundingClientRect();
    const box = active.getBoundingClientRect();
    scrubLabel.style.top = `${box.top - rail.top + box.height / 2}px`;
  }
}

function showScrub() {
  if (!scrubTrack.childElementCount) return;
  scrubEl.classList.add("show");
  scrubEl.setAttribute("aria-hidden", "false");
  placeScrubLabel();
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(() => {
    if (scrubEl.matches(":hover") || scrubEl.classList.contains("dragging")) return;
    scrubEl.classList.remove("show");
    scrubEl.setAttribute("aria-hidden", "true");
  }, 2500);
}

function scrubMonths() {
  const marks = [];
  for (const year of nest(state.days)) {
    for (const month of year.months) marks.push({ year: year.year, month: month.month });
  }
  return marks;
}

function monthAtRatio(ratio) {
  const years = nest(state.days);
  if (!years.length) return null;
  const clamped = Math.min(1, Math.max(0, ratio));
  if (years.length === 1) {
    const months = years[0].months;
    const index = Math.min(months.length - 1, Math.floor(clamped * months.length));
    return { year: years[0].year, month: months[index].month };
  }
  const pos = clamped * (years.length - 1);
  let yearIndex = Math.floor(pos);
  if (yearIndex >= years.length - 1) yearIndex = years.length - 2;
  const local = pos - yearIndex;
  if (local > 0.98) {
    const next = years[yearIndex + 1];
    return { year: next.year, month: next.months[0].month };
  }
  const months = years[yearIndex].months;
  const index = Math.min(months.length - 1, Math.floor(local * months.length));
  return { year: years[yearIndex].year, month: months[index].month };
}

function moveScrub(event) {
  const rect = scrubEl.getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
  const mark = monthAtRatio(ratio);
  if (!mark) return;
  pendingMark = mark;
  scrubLabel.hidden = false;
  scrubLabel.textContent = `${mark.year}年${mark.month}月`;
  scrubLabel.style.top = `${Math.min(rect.height, Math.max(0, event.clientY - rect.top))}px`;
  for (const button of scrubTrack.querySelectorAll(".scrub-year")) {
    button.classList.toggle("on", button.dataset.year === String(mark.year));
  }
  clearTimeout(scrubSeekTimer);
  scrubSeekTimer = setTimeout(() => {
    scrubSeekTimer = 0;
    if (pendingMark) jumpYear(pendingMark.year, pendingMark.month);
  }, 80);
}

function jumpYear(year, month = "") {
  const section = month
    ? document.getElementById(`m-${year}-${month}`)
    : mosaicEl.querySelector(`.photo-month[data-year="${year}"]`);
  if (section && !state.year && !state.month && !state.day) {
    section.scrollIntoView({ block: "start", inline: "nearest" });
    stageEl.scrollLeft = 0;
    showScrub();
    return;
  }
  selectTime(year, month, "");
}

function renderTree() {
  const years = nest(state.days);
  renderScrub();
  treeEl.replaceChildren();
  if (!years.length) {
    treeEl.append(h("p", { class: "hint", text: "扫描完成后，这里按拍摄时间列出。" }));
    return;
  }
  for (const year of years) {
    const open = String(state.year) === String(year.year);
    const button = h("button", { class: `year${open && !state.month ? " on" : ""}`, type: "button" }, [
      h("span", { text: String(year.year) }),
      h("span", { class: "count", text: String(year.count) }),
    ]);
    button.addEventListener("click", () => selectTime(year.year, "", ""));
    treeEl.append(button);
    if (!open) continue;
    for (const month of year.months) {
      const monthOn = String(state.month) === String(month.month) && !state.day;
      const monthBtn = h("button", { class: `month${monthOn ? " on" : ""}`, type: "button" }, [
        h("span", { text: monthName(month.month) }),
        h("span", { class: "count", text: String(month.count) }),
      ]);
      monthBtn.addEventListener("click", () => selectTime(year.year, month.month, ""));
      treeEl.append(monthBtn);
      if (String(state.month) !== String(month.month)) continue;
      for (const day of month.days) {
        const dayOn = String(state.day) === String(day.day);
        const dayBtn = h("button", { class: `day${dayOn ? " on" : ""}`, type: "button" }, [
          h("span", { text: `${day.day}日` }),
          h("span", { class: "count", text: String(day.count) }),
        ]);
        dayBtn.addEventListener("click", () => selectTime(year.year, month.month, day.day));
        treeEl.append(dayBtn);
      }
    }
  }
}

function rowHeight() {
  const width = mosaicEl.clientWidth || stageEl.clientWidth || 900;
  if (width > 1500) return 210;
  if (width > 1100) return 180;
  return 140;
}

function perRow() {
  const width = Math.max(280, (mosaicEl.clientWidth || 900) - 8);
  const cell = rowHeight() * 1.35;
  return Math.max(2, Math.floor(width / cell));
}

function trashIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("fill", "currentColor");
  shape.setAttribute("d", "M9 3h6l1 2h5v2H3V5h5l1-2zm1 6h2v10h-2V9zm4 0h2v10h-2V9zM6 9h2v10H6V9z");
  svg.append(shape);
  return svg;
}

function paintStars(stars, rating) {
  for (const button of stars.querySelectorAll(".star")) {
    button.classList.toggle("on", Number(button.dataset.value) <= rating);
  }
  const toggle = stars.parentElement?.querySelector(".star-toggle");
  if (!toggle) return;
  toggle.textContent = rating ? "★" : "☆";
  toggle.classList.toggle("on", rating > 0);
  toggle.title = rating ? `已加 ${rating} 星` : "加星";
}

async function ratePhoto(photo, rating, stars) {
  const response = await fetch("/api/library/rating", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: photo.path, rating }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    statusEl.textContent = data.error || "没能记下星级";
    return;
  }
  photo.rating = data.rating;
  paintStars(stars, photo.rating);
}

async function deletePhoto(photo) {
  const ask = await fetch("/api/library/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: photo.path }),
  });
  const plan = await ask.json().catch(() => ({}));
  if (!ask.ok) {
    statusEl.textContent = plan.error || "无法删除";
    return;
  }
  const names = (plan.paths || []).map((item) => item.split(/[/\\]/).pop());
  const message = names.length > 1
    ? `${names.join(" 和 ")} 是同一次拍摄的 CR2 和 JPG，会一起移入回收站。`
    : `把「${photo.name}」移入回收站？`;
  if (!window.confirm(message)) return;
  const response = await fetch("/api/library/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: photo.path, confirm: true }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    statusEl.textContent = data.error || "没能移入回收站";
    return;
  }
  const gone = new Set((data.deleted || []).map((item) => item.toLowerCase()));
  const openPath = state.open >= 0 ? state.photos[state.open]?.path : "";
  state.photos = state.photos.filter((item) => !gone.has(item.path.toLowerCase()));
  if (openPath && gone.has(openPath.toLowerCase())) closeViewer();
  renderMosaic(true);
  statusEl.textContent = names.length > 1 ? "这两张已移入回收站。" : "已移入回收站。";
  await loadTree();
  await refreshQuiet();
  if (!state.done && state.photos.length < 40) loadPhotos(false);
}

function makeTile(photo, index, wide) {
  const tile = h("div", { class: "tile", title: photo.name });
  tile.style.flex = wide ? "1 1 0" : "0 1 auto";
  tile.style.width = wide ? "auto" : `${Math.round(rowHeight() * 1.45)}px`;
  tile.style.maxWidth = wide ? "none" : "42%";
  tile.style.setProperty("--row-h", `${rowHeight()}px`);
  const img = h("img", { alt: photo.name, loading: "lazy" });
  img.src = `/api/library/thumb?path=${encodeURIComponent(photo.path)}`;
  img.addEventListener("error", () => tile.classList.add("broken"));
  const tools = h("div", { class: "tile-tools" });
  const rate = h("div", { class: "rate" });
  const toggle = h("button", {
    class: `tool star-toggle${photo.rating ? " on" : ""}`,
    type: "button",
    text: photo.rating ? "★" : "☆",
    title: photo.rating ? `已加 ${photo.rating} 星` : "加星",
  });
  const stars = h("div", { class: "stars" });
  for (let value = 1; value <= 5; value += 1) {
    const star = h("button", { class: "tool star", type: "button", text: "★", title: `${value} 星` });
    star.dataset.value = String(value);
    if (Number(photo.rating) >= value) star.classList.add("on");
    star.addEventListener("click", (event) => {
      event.stopPropagation();
      const next = Number(photo.rating) === value ? 0 : value;
      ratePhoto(photo, next, stars);
    });
    stars.append(star);
  }
  const del = h("button", { class: "tool del", type: "button", title: "移入回收站" });
  del.append(trashIcon());
  del.addEventListener("click", (event) => {
    event.stopPropagation();
    deletePhoto(photo);
  });
  rate.append(toggle, stars);
  tools.append(rate, del);
  tools.addEventListener("click", (event) => event.stopPropagation());
  tools.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tile.append(img, tools);
  let timer = 0;
  tile.addEventListener("click", () => {
    clearTimeout(timer);
    timer = setTimeout(() => openViewer(index), 220);
  });
  tile.addEventListener("dblclick", (event) => {
    event.preventDefault();
    clearTimeout(timer);
    reveal(photo.path);
  });
  return tile;
}

function holdScroll() {
  scrollLock += 1;
  setTimeout(() => {
    scrollLock = Math.max(0, scrollLock - 1);
  }, 200);
}

function appendRange(start, end) {
  const size = perRow();
  let index = start;
  while (index < end) {
    const first = state.photos[index];
    let section = document.getElementById(`m-${first.year}-${first.month}`);
    let body;
    if (!section) {
      section = h("section", { class: "photo-month", id: `m-${first.year}-${first.month}` });
      section.dataset.year = String(first.year);
      section.dataset.month = String(first.month);
      body = h("div", { class: "month-body" });
      section.append(body);
      mosaicEl.append(section);
    } else {
      body = section.querySelector(".month-body");
    }
    let row = body.lastElementChild;
    while (index < end) {
      const photo = state.photos[index];
      if (photo.year !== first.year || photo.month !== first.month) break;
      if (!row || row.children.length >= size) {
        row = h("div", { class: "row" });
        body.append(row);
      }
      row.append(makeTile(photo, index, true));
      index += 1;
    }
  }
  mosaicEl.querySelector(".more")?.remove();
  mosaicEl.querySelector(".empty")?.remove();
  if (!state.done) mosaicEl.append(h("div", { class: "more", text: "" }));
}

function renderMosaic(keepScroll) {
  const top = keepScroll ? stageEl.scrollTop : 0;
  holdScroll();
  mosaicEl.replaceChildren();
  if (!state.photos.length) {
    const empty = h("div", { class: "empty" });
    empty.append(h("div", { text: state.q ? "没有符合搜索的照片。" : "还没有照片。点左侧「扫描全部磁盘」，只会收录正常照片。" }));
    mosaicEl.append(empty);
    stageEl.scrollTop = 0;
    return;
  }
  appendRange(0, state.photos.length);
  stageEl.scrollTop = top;
}

async function loadPhotos(reset) {
  if (reset) loadGen += 1;
  else if (state.loading || state.done) return;
  const gen = loadGen;
  state.loading = true;
  if (reset) {
    state.photos = [];
    state.offset = 0;
    state.done = false;
  }
  const params = new URLSearchParams({ offset: String(state.offset), limit: "80" });
  if (state.year) params.set("year", state.year);
  if (state.month) params.set("month", state.month);
  if (state.day) params.set("day", state.day);
  if (state.q) params.set("q", state.q);
  let response;
  try {
    response = await fetch(`/api/library/photos?${params}`);
  } catch {
    if (gen !== loadGen) return;
    state.loading = false;
    statusEl.textContent = "照片列表加载失败";
    return;
  }
  const data = await response.json();
  if (gen !== loadGen) return;
  const photos = data.photos || [];
  const start = state.photos.length;
  state.photos.push(...photos);
  state.offset += photos.length;
  state.done = photos.length < 80;
  state.loading = false;
  if (start === 0) renderMosaic(false);
  else appendRange(start, state.photos.length);
}

async function loadTree() {
  const response = await fetch("/api/library/tree");
  const data = await response.json();
  state.days = data.days || [];
  renderTree();
}

function selectTime(year, month, day) {
  state.year = year ? String(year) : "";
  state.month = month ? String(month) : "";
  state.day = day ? String(day) : "";
  document.querySelector("#nav-all").classList.toggle("on", !state.year);
  renderTree();
  loadPhotos(true);
  stageEl.scrollTop = 0;
}

function showCount(total) {
  countEl.textContent = total ? `已收录 ${total} 张` : "还没有照片";
}

async function refreshQuiet() {
  const response = await fetch("/api/library/state");
  const data = await response.json();
  showCount(data.total || 0);
  state.scanning = Boolean(data.scanning);
  scanBtn.hidden = state.scanning;
  stopBtn.hidden = !state.scanning;
  if (data.scanning && data.progress) {
    statusEl.textContent = `正在扫描，已看到 ${data.progress.dirs || 0} 个目录，收录 ${data.progress.files || 0} 张。`;
  }
  return data;
}

function openViewer(index) {
  const photo = state.photos[index];
  if (!photo) return;
  state.open = index;
  viewer.hidden = false;
  viewerImg.alt = photo.name;
  viewerImg.src = `/api/library/view?path=${encodeURIComponent(photo.path)}`;
  viewerCaption.textContent = `${dateText(photo)}  ${photo.name}`;
}

function closeViewer() {
  viewer.hidden = true;
  viewerImg.removeAttribute("src");
  state.open = -1;
}

function stepViewer(delta) {
  if (state.open < 0) return;
  const next = state.open + delta;
  if (next < 0 || next >= state.photos.length) return;
  openViewer(next);
}

async function reveal(filePath) {
  const response = await fetch("/api/reveal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    statusEl.textContent = data.error || "无法打开所在文件夹";
  }
}

function watchScan() {
  const source = new EventSource("/api/library/events");
  source.addEventListener("progress", (event) => {
    const progress = JSON.parse(event.data);
    statusEl.textContent = `正在扫描，已看到 ${progress.dirs || 0} 个目录，收录 ${progress.files || 0} 张。`;
  });
  const finish = async (text) => {
    source.close();
    statusEl.textContent = text;
    state.scanning = false;
    scanBtn.hidden = false;
    stopBtn.hidden = true;
    const data = await refreshQuiet();
    await loadTree();
    await loadPhotos(true);
    if (!text) statusEl.textContent = data.summary?.finishedAt ? `上次扫描收录 ${data.total} 张。` : "";
  };
  source.addEventListener("done", (event) => {
    const summary = JSON.parse(event.data);
    finish(`扫描完成，收录 ${summary.total || summary.files || 0} 张。`);
  });
  source.addEventListener("cancelled", () => finish("扫描已停止，已收录的照片仍会保留。"));
  source.addEventListener("failed", (event) => {
    const data = JSON.parse(event.data);
    finish(data.error || "扫描失败");
  });
  source.addEventListener("idle", () => source.close());
}

document.querySelector("#nav-all").addEventListener("click", () => selectTime("", "", ""));
scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  const response = await fetch("/api/library/scan", { method: "POST" });
  const data = await response.json().catch(() => ({}));
  scanBtn.disabled = false;
  if (!response.ok) {
    statusEl.textContent = data.error || "无法开始扫描";
    return;
  }
  state.scanning = true;
  scanBtn.hidden = true;
  stopBtn.hidden = false;
  statusEl.textContent = `开始扫描 ${ (data.roots || []).join("、") }`;
  watchScan();
});
stopBtn.addEventListener("click", () => fetch("/api/library/cancel", { method: "POST" }));
searchEl.addEventListener("input", () => {
  state.q = searchEl.value.trim();
  clearTimeout(searchEl._timer);
  searchEl._timer = setTimeout(() => loadPhotos(true), 250);
});
stageEl.addEventListener("scroll", () => {
  if (scrollLock) return;
  if (!scrubEl.classList.contains("dragging")) showScrub();
  if (stageEl.scrollTop + stageEl.clientHeight > stageEl.scrollHeight - 400) loadPhotos(false);
});
scrubEl.addEventListener("mouseenter", () => clearTimeout(scrubTimer));
scrubEl.addEventListener("mouseleave", () => {
  if (!scrubEl.classList.contains("dragging")) showScrub();
});
scrubEl.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  dragOrigin = { x: event.clientX, y: event.clientY, dragging: false };
  scrubEl.setPointerCapture(event.pointerId);
});
scrubEl.addEventListener("pointermove", (event) => {
  if (!dragOrigin) return;
  const distance = Math.hypot(event.clientX - dragOrigin.x, event.clientY - dragOrigin.y);
  if (!dragOrigin.dragging && distance < 4) return;
  if (!dragOrigin.dragging) {
    dragOrigin.dragging = true;
    scrubEl.classList.add("dragging", "show");
    scrubEl.setAttribute("aria-hidden", "false");
    clearTimeout(scrubTimer);
  }
  event.preventDefault();
  moveScrub(event);
});
function finishScrubDrag() {
  const wasDragging = Boolean(dragOrigin?.dragging);
  dragOrigin = null;
  scrubEl.classList.remove("dragging");
  if (!wasDragging) return;
  blockScrubClick = true;
  clearTimeout(scrubSeekTimer);
  scrubSeekTimer = 0;
  const mark = pendingMark;
  pendingMark = null;
  if (mark) jumpYear(mark.year, mark.month);
  showScrub();
}
scrubEl.addEventListener("pointerup", finishScrubDrag);
scrubEl.addEventListener("pointercancel", finishScrubDrag);
scrubEl.addEventListener("click", (event) => {
  if (!blockScrubClick) return;
  blockScrubClick = false;
  event.preventDefault();
  event.stopPropagation();
}, true);
window.addEventListener("resize", () => {
  clearTimeout(window._layout);
  window._layout = setTimeout(() => renderMosaic(true), 150);
});
document.querySelector("#viewer-close").addEventListener("click", closeViewer);
document.querySelector("#viewer-open").addEventListener("click", () => {
  const photo = state.photos[state.open];
  if (photo) reveal(photo.path);
});
document.querySelector("#viewer-prev").addEventListener("click", () => stepViewer(-1));
document.querySelector("#viewer-next").addEventListener("click", () => stepViewer(1));
viewerImg.addEventListener("dblclick", () => {
  const photo = state.photos[state.open];
  if (photo) reveal(photo.path);
});
window.addEventListener("keydown", (event) => {
  if (viewer.hidden) return;
  if (event.key === "Escape") closeViewer();
  if (event.key === "ArrowLeft") stepViewer(-1);
  if (event.key === "ArrowRight") stepViewer(1);
});

refreshQuiet().then(async (data) => {
  await loadTree();
  await loadPhotos(true);
  if (data.scanning) watchScan();
  else if (data.summary?.finishedAt) statusEl.textContent = `上次扫描收录 ${data.total} 张。下次打开会直接显示这些记录。`;
});
