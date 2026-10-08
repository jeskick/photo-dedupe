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

function renderTree() {
  const years = nest(state.days);
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

function makeTile(photo, index, wide) {
  const tile = h("button", { class: "tile", type: "button", title: photo.name });
  tile.style.flex = wide ? "1 1 0" : "0 1 auto";
  tile.style.width = wide ? "auto" : `${Math.round(rowHeight() * 1.45)}px`;
  tile.style.maxWidth = wide ? "none" : "42%";
  tile.style.setProperty("--row-h", `${rowHeight()}px`);
  const img = h("img", { alt: photo.name, loading: "lazy" });
  img.src = `/api/library/thumb?path=${encodeURIComponent(photo.path)}`;
  img.addEventListener("error", () => tile.classList.add("broken"));
  tile.append(img);
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

function renderMosaic() {
  mosaicEl.replaceChildren();
  if (!state.photos.length) {
    const empty = h("div", { class: "empty" });
    empty.append(h("div", { text: state.q ? "没有符合搜索的照片。" : "还没有照片。点左侧「扫描全部磁盘」，只会收录正常照片。" }));
    mosaicEl.append(empty);
    return;
  }
    const size = perRow();
    let index = 0;
    while (index < state.photos.length) {
      const first = state.photos[index];
      const start = index;
      const group = [];
      while (index < state.photos.length) {
        const photo = state.photos[index];
        if (photo.year !== first.year || photo.month !== first.month) break;
        group.push(photo);
        index += 1;
      }
      const section = h("section", { class: "month", id: `m-${first.year}-${first.month}` });
      const label = state.day ? `${first.year}年${first.month}月${first.day}日` : `${first.year}年${first.month}月`;
      const body = h("div", { class: "month-body" });
      for (let cursor = 0; cursor < group.length; cursor += size) {
        const slice = group.slice(cursor, cursor + size);
        const row = h("div", { class: "row" });
        slice.forEach((photo, offset) => row.append(makeTile(photo, start + cursor + offset, true)));
        body.append(row);
      }
      section.append(body, h("div", { class: "month-head", text: label }));
      mosaicEl.append(section);
    }
  if (!state.done) mosaicEl.append(h("div", { class: "more", text: state.loading ? "正在加载…" : "" }));
}

async function loadPhotos(reset) {
  if (state.loading) return;
  if (!reset && state.done) return;
  state.loading = true;
  if (reset) {
    state.photos = [];
    state.offset = 0;
    state.done = false;
    renderMosaic();
  }
  const params = new URLSearchParams({ offset: String(state.offset), limit: "80" });
  if (state.year) params.set("year", state.year);
  if (state.month) params.set("month", state.month);
  if (state.day) params.set("day", state.day);
  if (state.q) params.set("q", state.q);
  const response = await fetch(`/api/library/photos?${params}`);
  const data = await response.json();
  const photos = data.photos || [];
  state.photos.push(...photos);
  state.offset += photos.length;
  state.done = photos.length < 80;
  state.loading = false;
  renderMosaic();
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
  if (stageEl.scrollTop + stageEl.clientHeight > stageEl.scrollHeight - 400) loadPhotos(false);
});
window.addEventListener("resize", () => {
  clearTimeout(window._layout);
  window._layout = setTimeout(renderMosaic, 150);
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
