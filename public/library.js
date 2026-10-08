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
const infoEl = document.querySelector("#viewer-info");
const viewerVideo = document.querySelector("#viewer-video");
const minEdgeEl = document.querySelector("#min-edge");
const excludeList = document.querySelector("#exclude-list");
const FOLD_KEY = "photo-library-folds";
let scrubTimer = 0;
let scrollLock = 0;
let dragOrigin = null;
let blockScrubClick = false;
let pendingMark = null;
let scrubSeekTimer = 0;
let loadGen = 0;
let infoGen = 0;

const state = {
  days: [],
  photos: [],
  offset: 0,
  year: "",
  month: "",
  day: "",
  q: "",
  rating: "",
  kind: "photo",
  origin: "",
  label: "",
  person: "",
  marks: { labels: { person: 0, animal: 0, landscape: 0 }, names: [] },
  settings: { excludeDirs: [], minEdgePhoto: 0, minEdgeVideo: 0 },
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

function naturalWidth(photo) {
  const height = rowHeight();
  const w = Number(photo.width) || 0;
  const h = Number(photo.height) || 0;
  let ratio = 1.5;
  if (w > 0 && h > 0) ratio = w / h;
  ratio = Math.min(1.85, Math.max(0.72, ratio));
  const limit = Math.max(160, (mosaicEl.clientWidth || 900) - 8);
  return Math.min(limit, Math.round(height * ratio));
}

function finishRow(row) {
  if (!row) return;
  const stretch = row.children.length >= perRow();
  row.classList.toggle("short", !stretch);
  for (const tile of row.children) {
    if (stretch) {
      tile.style.flex = "1 1 0";
      tile.style.width = "auto";
      tile.style.maxWidth = "none";
    } else {
      tile.style.flex = "0 0 auto";
      tile.style.width = `${tile.dataset.natural}px`;
      tile.style.maxWidth = "none";
    }
  }
}

function makeTile(photo, index) {
  const tile = h("div", { class: "tile", title: photo.name });
  tile.dataset.natural = String(naturalWidth(photo));
  tile.style.flex = "1 1 0";
  tile.style.setProperty("--row-h", `${rowHeight()}px`);
  let visual;
  const playable = state.kind === "video" && [".mp4", ".m4v", ".mov"].includes(String(photo.ext || "").toLowerCase());
  if (state.kind === "video" && !playable) {
    visual = h("div", { class: "video-fallback", text: String(photo.ext || "视频").replace(/^\./, "").toUpperCase() });
  } else if (playable) {
    visual = document.createElement("video");
    visual.muted = true;
    visual.preload = "metadata";
    visual.src = `/api/library/media?path=${encodeURIComponent(photo.path)}#t=0.2`;
    visual.addEventListener("error", () => tile.classList.add("broken"));
  } else {
    visual = h("img", { alt: photo.name, loading: "lazy" });
    visual.src = `/api/library/thumb?path=${encodeURIComponent(photo.path)}`;
    visual.addEventListener("error", () => tile.classList.add("broken"));
  }
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
  tile.append(visual, tools);
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
    if (row && row.children.length >= size) row = null;
    while (index < end) {
      const photo = state.photos[index];
      if (photo.year !== first.year || photo.month !== first.month) break;
      if (!row || row.children.length >= size) {
        if (row) finishRow(row);
        row = h("div", { class: "row" });
        body.append(row);
      }
      row.append(makeTile(photo, index));
      index += 1;
    }
    if (row) finishRow(row);
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
    const noun = state.kind === "video" ? "视频" : "照片";
    const sceneName = { person: "人物", animal: "动物", landscape: "风景" };
    const emptyText = state.q
      ? `没有符合搜索的${noun}。`
      : state.person
        ? `还没有标成「${state.person}」的照片。`
        : state.label
          ? `还没有标成${sceneName[state.label] || "这个类型"}的照片。`
          : state.origin
            ? `还没有${state.origin === "camera" ? "相机" : "手机"}拍摄的${noun}。`
            : state.rating
              ? `还没有 ${state.rating} 星的${noun}。`
              : `还没有${noun}。点左侧「扫描全部磁盘」，只会收录正常${noun}。`;
    empty.append(h("div", { text: emptyText }));
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
  if (state.rating) params.set("rating", state.rating);
  params.set("kind", state.kind);
  if (state.origin) params.set("origin", state.origin);
  if (state.label) params.set("label", state.label);
  if (state.person) params.set("person", state.person);
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

let treeGen = 0;
async function loadTree() {
  const gen = ++treeGen;
  const params = new URLSearchParams();
  params.set("kind", state.kind);
  if (state.rating) params.set("rating", state.rating);
  if (state.origin) params.set("origin", state.origin);
  if (state.label) params.set("label", state.label);
  if (state.person) params.set("person", state.person);
  const response = await fetch(`/api/library/tree?${params}`);
  const data = await response.json();
  if (gen !== treeGen) return;
  state.days = data.days || [];
  renderTree();
}

function selectTime(year, month, day) {
  state.year = year ? String(year) : "";
  state.month = month ? String(month) : "";
  state.day = day ? String(day) : "";
  document.querySelector("#nav-all").classList.toggle("on", state.kind !== "video" && !state.year);
  document.querySelector("#nav-video").classList.toggle("on", state.kind === "video" && !state.year);
  renderTree();
  loadPhotos(true);
  stageEl.scrollTop = 0;
}

function showCount(total) {
  const noun = state.kind === "video" ? "个视频" : "张";
  countEl.textContent = total ? `已收录 ${total} ${noun}` : (state.kind === "video" ? "还没有视频" : "还没有照片");
}

async function refreshQuiet() {
  const response = await fetch("/api/library/state");
  const data = await response.json();
  showCount(state.kind === "video" ? data.videos : data.photos);
  state.scanning = Boolean(data.scanning);
  scanBtn.hidden = state.scanning;
  stopBtn.hidden = !state.scanning;
  if (data.scanning && data.progress) {
    statusEl.textContent = `正在扫描，已看到 ${data.progress.dirs || 0} 个目录，收录 ${data.progress.files || 0} ${state.kind === "video" ? "个" : "张"}。`;
  }
  return data;
}

async function showPhotoInfo(photo) {
  const gen = ++infoGen;
  infoEl.hidden = false;
  infoEl.replaceChildren(h("p", { class: "hint", text: "正在读取拍摄信息…" }));
  const response = await fetch(`/api/library/info?path=${encodeURIComponent(photo.path)}`);
  const data = await response.json().catch(() => ({}));
  if (gen !== infoGen) return;
  const list = h("dl");
  for (const field of data.fields || []) {
    list.append(h("dt", { text: field.label }), h("dd", { text: field.value }));
  }
  if (!data.fields?.length) list.append(h("p", { class: "hint", text: data.error || "没有读到拍摄信息" }));
  const faces = h("div", { class: "face-names" });
  if (state.kind !== "video") {
    faces.append(h("p", { class: "hint", text: "人物名字。留空只取消这一张，相似的脸会一起标上。" }));
    if (!(data.faces || []).length) faces.append(h("p", { class: "hint", text: "这张还没有识别出人脸。" }));
    for (const face of data.faces || []) {
      const input = h("input", { type: "text", value: face.name || "", placeholder: "标记名字", maxlength: "40" });
      input.addEventListener("change", async () => {
        const response = await fetch("/api/library/face", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: face.id, name: input.value }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          statusEl.textContent = result.error || "名字没能保存";
          return;
        }
        statusEl.textContent = result.name
          ? `已把 ${result.count} 张相似的脸标成「${result.name}」。`
          : "已取消这一张的名字。";
        await loadMarks();
        if (state.person || state.label) loadPhotos(true);
      });
      faces.append(input);
    }
  }
  infoEl.replaceChildren(list, faces);
}

let viewScale = 1;
let viewX = 0;
let viewY = 0;

function applyZoom() {
  viewerImg.style.transform = `translate(${viewX}px, ${viewY}px) scale(${viewScale})`;
  viewerImg.classList.toggle("zoomed", viewScale > 1);
}

function resetZoom() {
  viewScale = 1;
  viewX = 0;
  viewY = 0;
  applyZoom();
}

function openViewer(index) {
  const photo = state.photos[index];
  if (!photo) return;
  state.open = index;
  viewer.hidden = false;
  resetZoom();
  viewerCaption.textContent = `${dateText(photo)}  ${photo.name}`;
  if (state.kind === "video") {
    viewerImg.hidden = true;
    viewerImg.removeAttribute("src");
    viewerVideo.hidden = false;
    viewerVideo.src = `/api/library/media?path=${encodeURIComponent(photo.path)}`;
  } else {
    viewerVideo.pause();
    viewerVideo.hidden = true;
    viewerVideo.removeAttribute("src");
    viewerImg.hidden = false;
    viewerImg.alt = photo.name;
    viewerImg.src = `/api/library/view?path=${encodeURIComponent(photo.path)}`;
  }
  showPhotoInfo(photo);
}

function closeViewer() {
  infoGen += 1;
  viewer.hidden = true;
  viewerImg.removeAttribute("src");
  viewerVideo.pause();
  viewerVideo.removeAttribute("src");
  resetZoom();
  infoEl.hidden = true;
  infoEl.replaceChildren();
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
    statusEl.textContent = `正在扫描，已看到 ${progress.dirs || 0} 个目录，收录 ${progress.files || 0} ${state.kind === "video" ? "个" : "张"}。`;
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
    const unit = state.kind === "video" ? "个" : "张";
    const parts = [`扫描完成，收录 ${summary.total || summary.files || 0} ${unit}。`];
    if (summary.added) parts.push(`新加入 ${summary.added} ${unit}。`);
    if (summary.removed) parts.push(`已去掉 ${summary.removed} ${unit}不存在的。`);
    finish(parts.join(""));
  });
  source.addEventListener("cancelled", () => finish("扫描已停止，已收录的照片仍会保留。"));
  source.addEventListener("failed", (event) => {
    const data = JSON.parse(event.data);
    finish(data.error || "扫描失败");
  });
  source.addEventListener("idle", () => source.close());
}

function applyFolds() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(FOLD_KEY) || "{}");
  } catch {
    saved = {};
  }
  for (const section of document.querySelectorAll(".fold")) {
    const open = section.dataset.fold === "scan" ? saved.scan === true : saved[section.dataset.fold] !== false;
    section.classList.toggle("open", open);
    section.querySelector(".fold-head").setAttribute("aria-expanded", open ? "true" : "false");
  }
}

function toggleFold(section) {
  const open = !section.classList.contains("open");
  section.classList.toggle("open", open);
  section.querySelector(".fold-head").setAttribute("aria-expanded", open ? "true" : "false");
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(FOLD_KEY) || "{}");
  } catch {
    saved = {};
  }
  saved[section.dataset.fold] = open;
  localStorage.setItem(FOLD_KEY, JSON.stringify(saved));
}

applyFolds();
for (const section of document.querySelectorAll(".fold")) {
  section.querySelector(".fold-head").addEventListener("click", () => toggleFold(section));
}
document.querySelector("#ratings").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const rating = button.dataset.rating;
  state.rating = state.rating === rating ? "" : rating;
  for (const item of document.querySelectorAll("#ratings button")) {
    item.classList.toggle("on", item.dataset.rating === state.rating);
  }
  loadTree();
  loadPhotos(true);
  stageEl.scrollTop = 0;
});
function renderExcludes() {
  excludeList.replaceChildren();
  for (const dir of state.settings.excludeDirs || []) {
    const item = h("li");
    const label = h("span", { text: dir, title: dir });
    const remove = h("button", { type: "button", text: "移除" });
    remove.addEventListener("click", () => saveSettings({ excludeDirs: state.settings.excludeDirs.filter((entry) => entry !== dir) }));
    item.append(label, remove);
    excludeList.append(item);
  }
}

function renderEdge() {
  minEdgeEl.value = String(state.kind === "video" ? state.settings.minEdgeVideo : state.settings.minEdgePhoto);
}

async function saveSettings(patch) {
  const response = await fetch("/api/library/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      excludeDirs: patch.excludeDirs || state.settings.excludeDirs,
      minEdgePhoto: patch.minEdgePhoto ?? state.settings.minEdgePhoto,
      minEdgeVideo: patch.minEdgeVideo ?? state.settings.minEdgeVideo,
    }),
  });
  state.settings = await response.json();
  renderExcludes();
  renderEdge();
}

async function loadSettings() {
  const response = await fetch("/api/library/settings");
  state.settings = await response.json();
  renderExcludes();
  renderEdge();
}

function setKind(kind) {
  state.kind = kind;
  if (kind === "video") {
    state.label = "";
    state.person = "";
    renderMarks();
  }
  state.year = "";
  state.month = "";
  state.day = "";
  closeViewer();
  renderEdge();
  selectTime("", "", "");
  loadTree();
  refreshQuiet();
}

const SCENE_TEXT = { person: "人物", animal: "动物", landscape: "风景" };

function renderMarks() {
  for (const button of document.querySelectorAll("#scenes button")) {
    const count = state.marks.labels?.[button.dataset.label] || 0;
    button.textContent = `${SCENE_TEXT[button.dataset.label]} ${count}`;
    button.classList.toggle("on", state.label === button.dataset.label && !state.person);
  }
  const names = document.querySelector("#names");
  names.replaceChildren();
  for (const item of state.marks.names || []) {
    const button = h("button", { type: "button", text: `${item.name} ${item.count}` });
    button.classList.toggle("on", state.person === item.name);
    button.addEventListener("click", () => {
      state.person = state.person === item.name ? "" : item.name;
      state.label = "";
      if (state.person && state.kind === "video") state.kind = "photo";
      renderMarks();
      loadTree();
      loadPhotos(true);
      stageEl.scrollTop = 0;
    });
    names.append(button);
  }
}

async function loadMarks() {
  const response = await fetch("/api/library/marks");
  state.marks = await response.json();
  renderMarks();
}

function applyMarkFilter() {
  document.querySelector("#nav-all").classList.toggle("on", state.kind !== "video" && !state.year);
  document.querySelector("#nav-video").classList.toggle("on", state.kind === "video" && !state.year);
  renderMarks();
  loadTree();
  loadPhotos(true);
  stageEl.scrollTop = 0;
}

document.querySelector("#scenes").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const label = button.dataset.label;
  state.label = state.label === label && !state.person ? "" : label;
  state.person = "";
  if (state.label && state.kind === "video") state.kind = "photo";
  applyMarkFilter();
});

let recognizeTimer = 0;
async function watchRecognize() {
  clearInterval(recognizeTimer);
  recognizeTimer = setInterval(async () => {
    const data = await refreshQuiet();
    const recognizeBtn = document.querySelector("#recognize");
    const recognizeStop = document.querySelector("#recognize-stop");
    const running = Boolean(data.recognizing);
    recognizeBtn.hidden = running;
    recognizeStop.hidden = !running;
    if (data.recognize) statusEl.textContent = `${data.recognize.phase} ${data.recognize.done || 0} / ${data.recognize.total || 0}`;
    if (!running) {
      clearInterval(recognizeTimer);
      statusEl.textContent = data.recognizeNote || "识别结束。左侧可以按人物、动物、风景或名字查看。";
      await loadMarks();
      if (state.label || state.person) loadPhotos(true);
    }
  }, 1000);
}

document.querySelector("#recognize").addEventListener("click", async () => {
  const response = await fetch("/api/library/recognize", { method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    statusEl.textContent = data.error || "识别没有开始";
    return;
  }
  document.querySelector("#recognize").hidden = true;
  document.querySelector("#recognize-stop").hidden = false;
  statusEl.textContent = `开始识别 ${data.total} 张照片。`;
  watchRecognize();
});
document.querySelector("#recognize-stop").addEventListener("click", () => {
  fetch("/api/library/recognize/cancel", { method: "POST" });
});

document.querySelector("#nav-all").addEventListener("click", () => setKind("photo"));
document.querySelector("#nav-video").addEventListener("click", () => setKind("video"));
document.querySelector("#origins").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const origin = button.dataset.origin;
  state.origin = state.origin === origin ? "" : origin;
  for (const item of document.querySelectorAll("#origins button")) {
    item.classList.toggle("on", item.dataset.origin === state.origin);
  }
  loadTree();
  loadPhotos(true);
  stageEl.scrollTop = 0;
});
minEdgeEl.addEventListener("change", () => {
  const value = Number(minEdgeEl.value) || 0;
  if (state.kind === "video") saveSettings({ minEdgeVideo: value });
  else saveSettings({ minEdgePhoto: value });
});
document.querySelector("#exclude-add").addEventListener("click", async () => {
  const response = await fetch("/api/pick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "one" }),
  });
  const data = await response.json().catch(() => ({}));
  const picked = (data.paths || []).filter(Boolean);
  if (!picked.length) return;
  saveSettings({ excludeDirs: [...new Set([...state.settings.excludeDirs, ...picked])] });
});
viewer.addEventListener("wheel", (event) => {
  if (viewer.hidden || viewerImg.hidden || event.target.closest("#viewer-info")) return;
  event.preventDefault();
  const next = Math.min(8, Math.max(1, viewScale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
  if (next <= 1.01) {
    resetZoom();
    return;
  }
  const rect = viewerImg.getBoundingClientRect();
  const ox = event.clientX - (rect.left + rect.width / 2);
  const oy = event.clientY - (rect.top + rect.height / 2);
  const ratio = next / viewScale;
  viewX = ox - (ox - viewX) * ratio;
  viewY = oy - (oy - viewY) * ratio;
  viewScale = next;
  applyZoom();
}, { passive: false });
let pan = null;
viewerImg.addEventListener("pointerdown", (event) => {
  if (viewScale <= 1 || event.button !== 0) return;
  pan = { x: event.clientX, y: event.clientY, ox: viewX, oy: viewY };
  viewerImg.setPointerCapture(event.pointerId);
});
viewerImg.addEventListener("pointermove", (event) => {
  if (!pan) return;
  viewX = pan.ox + event.clientX - pan.x;
  viewY = pan.oy + event.clientY - pan.y;
  applyZoom();
});
viewerImg.addEventListener("pointerup", () => { pan = null; });
scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  const response = await fetch("/api/library/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: state.kind }),
  });
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

loadSettings().then(() => refreshQuiet()).then(async (data) => {
  await loadMarks();
  await loadTree();
  await loadPhotos(true);
  if (data.recognizing) watchRecognize();
  if (data.scanning) watchScan();
  else if (data.summary?.finishedAt) statusEl.textContent = `上次扫描收录 ${data.total} 张。下次打开会直接显示这些记录。`;
});
