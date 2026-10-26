"use strict";

const FACE_DEG = 15;   // 24 faces × 15° = 360°
// Drum radius comes from --radius in popup.css (larger on the new-tab page).
const RADIUS = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--radius")) || 172;
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Older ICU builds only know the pre-rename zone ids.
const TZ_ALIASES = { "Europe/Kyiv": "Europe/Kiev", "America/Nuuk": "America/Godthab", "Asia/Yangon": "Asia/Rangoon" };

const $ = (id) => document.getElementById(id);

// ---------- Storage (chrome.storage.sync, localStorage when opened as a plain page) ----------

const store = {
  async get() {
    if (globalThis.chrome?.storage?.sync) return chrome.storage.sync.get(["cities", "hour12", "clocks"]);
    try { return JSON.parse(localStorage.getItem("worldclock") || "{}"); } catch { return {}; }
  },
  async set(data) {
    if (globalThis.chrome?.storage?.sync) return chrome.storage.sync.set(data);
    try { localStorage.setItem("worldclock", JSON.stringify(data)); } catch { /* ignore */ }
  },
};

// ---------- Time zone helpers ----------

function resolveTz(tz) {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { /* fall through */ }
  const alias = TZ_ALIASES[tz];
  if (alias) {
    try { new Intl.DateTimeFormat("en", { timeZone: alias }); return alias; } catch { /* fall through */ }
  }
  return null;
}

const partsCache = new Map();
function zoneParts(tz, date) {
  let fmt = partsCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
    partsCache.set(tz, fmt);
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour % 24, minute: +p.minute, second: +p.second, weekday: p.weekday,
  };
}

// Offset from UTC in minutes, derived from the zone's wall clock.
function offsetMinutes(tz, date) {
  const p = zoneParts(tz, date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

function fmtOffset(min, { signZero = true } = {}) {
  if (min === 0) return signZero ? "±0" : "0";
  const sign = min > 0 ? "+" : "−";
  const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
  return m ? `${sign}${h}:${String(m).padStart(2, "0")}` : `${sign}${h}`;
}

function fmtDiff(min) {
  if (min === 0) return "same time";
  const sign = min > 0 ? "+" : "−";
  const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
  return `${sign}${h}h${m ? ` ${m}m` : ""}`;
}

const isNight = (hour) => hour < 6 || hour >= 18;

// The face (−11 … +12) whose ring hour equals this city's current hour.
function faceFor(cityHour, utcHour) {
  let k = ((cityHour - utcHour + 36) % 24) - 12;
  if (k === -12) k = 12;
  return k;
}

function cityFromZone(tz) {
  const name = tz.split("/").pop().replace(/_/g, " ");
  const region = tz.includes("/") ? tz.split("/")[0] : "";
  return { name, country: region, tz };
}

// ---------- Search index ----------

const fold = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const SEARCH_INDEX = (() => {
  const out = [];
  const seen = new Set();
  for (const [name, country, tz] of CITIES) {
    const real = resolveTz(tz);
    if (!real) continue;
    out.push({ name, country, tz: real });
    seen.add(fold(name));
  }
  const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : [];
  for (const tz of zones) {
    if (!tz.includes("/") || tz.startsWith("Etc/")) continue;
    const c = cityFromZone(tz);
    if (seen.has(fold(c.name))) continue;
    seen.add(fold(c.name));
    out.push(c);
  }
  return out;
})();

function search(query, exclude) {
  const q = fold(query.trim());
  if (!q) return [];
  const scored = [];
  for (const c of SEARCH_INDEX) {
    if (exclude.has(idOf(c))) continue;
    const name = fold(c.name);
    let score;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (fold(c.country).startsWith(q)) score = 2;
    else if (fold(c.tz).includes(q.replace(/ /g, "_"))) score = 3;
    else continue;
    scored.push([score, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
  return scored.slice(0, 8).map(([, c]) => c);
}

// ---------- State ----------

const idOf = (c) => `${c.name}|${c.tz}`;

const state = {
  cities: [],
  hour12: false,
  rotation: 0,      // degrees the column is turned
  clocks: [],       // city ids shown on the two Swiss clocks
};

function defaultCities() {
  const local = SEARCH_INDEX.find((c) => c.tz === LOCAL_TZ) || cityFromZone(LOCAL_TZ);
  const picks = [local];
  for (const name of ["Berlin", "New York", "Tokyo"]) {
    const c = SEARCH_INDEX.find((x) => x.name === name);
    if (c && !picks.some((p) => p.tz === c.tz)) picks.push(c);
  }
  return picks;
}

const save = () => store.set({ cities: state.cities, hour12: state.hour12, clocks: state.clocks });

// ---------- The column ----------

const faces = [];
const ringSegs = [];

function buildColumn() {
  const cyl = $("cylinder");
  for (let i = 0; i < 24; i++) {
    const k = i - 11;
    const face = document.createElement("div");
    face.className = "face";
    face.style.transform = `rotateY(${i * FACE_DEG}deg) translateZ(${RADIUS}px)`;
    face.innerHTML = `<div class="track"></div><div class="body"></div><div class="zone">${fmtOffset(k * 60)}</div>`;
    cyl.appendChild(face);
    faces.push({ k, el: face, body: face.children[1] });
  }

  // The hour ring is separate from the fixed faces, as on the real clock:
  // it carries the numbers 0–23 and turns once a day around the column.
  // It runs just outside the column's corners so it never cuts into them
  // when a number sits between two faces.
  const ringRadius = RADIUS / Math.cos((FACE_DEG / 2) * Math.PI / 180) + 2;
  const faceW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--face-w")) || 46;
  const segW = faceW * ringRadius / RADIUS;
  const ring = document.createElement("div");
  ring.className = "ring";
  ring.id = "ring";
  ring.style.width = `${segW}px`;
  ring.style.left = `${(faceW - segW) / 2}px`;
  for (let h = 0; h < 24; h++) {
    const seg = document.createElement("div");
    seg.className = isNight(h) ? "seg night" : "seg";
    seg.style.transform = `rotateY(${(h + 11) * FACE_DEG}deg) translateZ(${ringRadius}px)`;
    ring.appendChild(seg);
    ringSegs.push({ h, el: seg });
  }
  cyl.appendChild(ring);
}

// Hour h sits over the face where it is exactly h:00 right now, so the ring
// creeps westward 15° an hour and each number glides from face to face.
function renderRing(now) {
  const t = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  $("ring").style.transform = `rotateY(${-t * FACE_DEG}deg)`;
  for (const s of ringSegs) {
    const label = state.hour12 ? String(s.h % 12 || 12) : String(s.h).padStart(2, "0");
    if (s.el.textContent !== label) s.el.textContent = label;
  }
}

function renderColumn(now) {
  const utcHour = now.getUTCHours();
  const byFace = new Map();
  for (const c of state.cities) {
    const k = faceFor(zoneParts(c.tz, now).hour, utcHour);
    if (!byFace.has(k)) byFace.set(k, []);
    byFace.get(k).push(c.name);
  }

  const front = frontFace();
  for (const f of faces) {
    const mine = byFace.get(f.k) || [];
    const names = mine.length ? mine.slice(0, 3) : [FACE_LABELS[f.k]];
    const html = names.map((n) => `<span class="name${mine.length ? "" : " ref"}">${escapeHtml(n)}</span>`).join("");
    if (f.body.innerHTML !== html) f.body.innerHTML = html;
    f.el.title = mine.length ? mine.join(", ") : `UTC${fmtOffset(f.k * 60)}`;

    f.el.classList.toggle("mine", mine.length > 0);
    f.el.classList.toggle("front", f.k === front);
  }
  renderRing(now);
}

function frontFace() {
  const i = (((Math.round(state.rotation / FACE_DEG)) % 24) + 24) % 24;
  return i - 11;
}

function applyRotation() {
  $("cylinder").style.transform = `translateZ(${-RADIUS}px) rotateY(${-state.rotation}deg)`;
}

// Turn the column the short way round so face k is in front.
function turnTo(k) {
  const target = (k + 11) * FACE_DEG;
  let delta = ((target - state.rotation) % 360 + 540) % 360 - 180;
  state.rotation += delta;
  applyRotation();
  renderColumn(new Date());
}

function wireColumnDrag() {
  const rot = $("rotunda");
  let startX = 0, startRot = 0, dragging = false;

  rot.addEventListener("pointerdown", (e) => {
    dragging = true;
    startX = e.clientX;
    startRot = state.rotation;
    rot.setPointerCapture(e.pointerId);
    rot.classList.add("dragging");
  });
  rot.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    state.rotation = startRot - (e.clientX - startX) * 0.45;
    applyRotation();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    rot.classList.remove("dragging");
    state.rotation = Math.round(state.rotation / FACE_DEG) * FACE_DEG;
    applyRotation();
    renderColumn(new Date());
  };
  rot.addEventListener("pointerup", end);
  rot.addEventListener("pointercancel", end);

  rot.addEventListener("wheel", (e) => {
    e.preventDefault();
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    state.rotation = Math.round(state.rotation / FACE_DEG) * FACE_DEG + Math.sign(d) * FACE_DEG;
    applyRotation();
    renderColumn(new Date());
  }, { passive: false });
}

// ---------- City list ----------

function renderList() {
  const list = $("cityList");
  list.textContent = "";
  $("emptyHint").hidden = state.cities.length > 0;

  for (const c of state.cities) {
    const li = document.createElement("li");
    li.className = "city";
    li.draggable = true;
    li.dataset.id = idOf(c);
    li.innerHTML = `
      <div class="where">
        <div class="name"></div>
        <div class="sub"></div>
      </div>
      <div class="time"><div class="clock"></div><div class="day"></div></div>
      <button class="remove" type="button" title="Remove">×</button>`;
    li.querySelector(".name").textContent = c.name;
    li.querySelector(".remove").setAttribute("aria-label", `Remove ${c.name}`);
    list.appendChild(li);
  }
  renderClockPickers();
  tick();
}

function updateListTimes(now) {
  const local = zoneParts(LOCAL_TZ, now);
  const localOff = offsetMinutes(LOCAL_TZ, now);
  const localDay = Date.UTC(local.year, local.month - 1, local.day);

  for (const li of $("cityList").children) {
    const c = state.cities.find((x) => idOf(x) === li.dataset.id);
    if (!c) continue;
    const p = zoneParts(c.tz, now);
    const off = offsetMinutes(c.tz, now);

    const mm = String(p.minute).padStart(2, "0");
    let clock;
    if (state.hour12) {
      clock = `${p.hour % 12 || 12}:${mm}<span class="ampm">${p.hour < 12 ? "AM" : "PM"}</span>`;
    } else {
      clock = `${String(p.hour).padStart(2, "0")}:${mm}`;
    }
    const clockEl = li.querySelector(".clock");
    if (clockEl.innerHTML !== clock) clockEl.innerHTML = clock;

    const dayDiff = Math.round((Date.UTC(p.year, p.month - 1, p.day) - localDay) / 86400000);
    const rel = dayDiff === 0 ? "Today" : dayDiff === 1 ? "Tomorrow" : dayDiff === -1 ? "Yesterday" : "";
    li.querySelector(".day").textContent = `${isNight(p.hour) ? "☾" : "☀"} ${rel ? `${rel}, ` : ""}${p.weekday}`;

    const isLocal = c.tz === LOCAL_TZ;
    const sub = [c.country, `UTC${fmtOffset(off)}`, isLocal ? "your time" : fmtDiff(off - localOff)].filter(Boolean);
    li.querySelector(".sub").textContent = sub.join(" · ");

    li.classList.toggle("night", isNight(p.hour));
    li.classList.toggle("local", isLocal);
  }
}

function wireList() {
  const list = $("cityList");

  list.addEventListener("click", (e) => {
    const li = e.target.closest(".city");
    if (!li) return;
    if (e.target.closest(".remove")) {
      state.cities = state.cities.filter((c) => idOf(c) !== li.dataset.id);
      save();
      renderList();
      return;
    }
    const c = state.cities.find((x) => idOf(x) === li.dataset.id);
    const now = new Date();
    turnTo(faceFor(zoneParts(c.tz, now).hour, now.getUTCHours()));
  });

  // Drag to reorder
  let dragId = null;
  list.addEventListener("dragstart", (e) => {
    const li = e.target.closest(".city");
    dragId = li.dataset.id;
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  list.addEventListener("dragover", (e) => {
    if (!dragId) return;
    e.preventDefault();
    const dragging = list.querySelector(".dragging");
    const after = [...list.querySelectorAll(".city:not(.dragging)")]
      .find((li) => e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2);
    list.insertBefore(dragging, after || null);
  });
  list.addEventListener("dragend", () => {
    list.querySelector(".dragging")?.classList.remove("dragging");
    const order = [...list.children].map((li) => li.dataset.id);
    state.cities.sort((a, b) => order.indexOf(idOf(a)) - order.indexOf(idOf(b)));
    dragId = null;
    save();
  });
}

// ---------- Add city ----------

function wireSearch() {
  const input = $("search");
  const box = $("suggestions");
  let results = [];
  let active = 0;

  const close = () => { box.hidden = true; results = []; };

  const draw = () => {
    box.textContent = "";
    if (!input.value.trim()) return close();
    box.hidden = false;
    if (!results.length) {
      box.innerHTML = `<li class="none">No matching city or time zone</li>`;
      return;
    }
    const now = new Date();
    results.forEach((c, i) => {
      const li = document.createElement("li");
      li.className = i === active ? "active" : "";
      li.setAttribute("role", "option");
      const p = zoneParts(c.tz, now);
      li.innerHTML = `<span></span><span class="meta"></span>`;
      li.firstChild.textContent = c.country ? `${c.name}, ${c.country}` : c.name;
      li.lastChild.textContent = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} · UTC${fmtOffset(offsetMinutes(c.tz, now))}`;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); add(c); });
      box.appendChild(li);
    });
  };

  const add = (c) => {
    if (!c) return;
    state.cities.push({ name: c.name, country: c.country, tz: c.tz });
    save();
    renderList();
    input.value = "";
    close();
    const now = new Date();
    turnTo(faceFor(zoneParts(c.tz, now).hour, now.getUTCHours()));
  };

  input.addEventListener("input", () => {
    results = search(input.value, new Set(state.cities.map(idOf)));
    active = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && results.length) { active = (active + 1) % results.length; draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp" && results.length) { active = (active - 1 + results.length) % results.length; draw(); e.preventDefault(); }
    else if (e.key === "Enter") { add(results[active]); e.preventDefault(); }
    else if (e.key === "Escape" && !box.hidden) { close(); e.preventDefault(); }
  });
  input.addEventListener("blur", close);
}

// ---------- Swiss railway clocks ----------

const SVG_NS = "http://www.w3.org/2000/svg";
const swiss = [];   // { root, hourHand, minuteHand, secondHand, select, info, offsetMs }

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent.appendChild(el);
  return el;
}

function buildSwissClocks() {
  for (const fig of document.querySelectorAll(".swiss")) {
    const svg = fig.querySelector(".dial");
    svgEl("circle", { r: 99, class: "bezel" }, svg);
    svgEl("circle", { r: 93, class: "face-plate" }, svg);
    // 60 minute strokes, every fifth a heavy hour bar
    for (let i = 0; i < 60; i++) {
      const hour = i % 5 === 0;
      svgEl("rect", hour
        ? { x: -3.5, y: -89, width: 7, height: 23, class: "mark", transform: `rotate(${i * 6})` }
        : { x: -1.3, y: -89, width: 2.6, height: 7, class: "mark", transform: `rotate(${i * 6})` }, svg);
    }
    const hourHand = svgEl("polygon", { points: "-6.2,16 6.2,16 5,-58 -5,-58", class: "hand" }, svg);
    const minuteHand = svgEl("polygon", { points: "-5,20 5,20 3.4,-86 -3.4,-86", class: "hand" }, svg);
    const secondHand = svgEl("g", { class: "second" }, svg);
    svgEl("rect", { x: -1.2, y: -60, width: 2.4, height: 90 }, secondHand);
    svgEl("circle", { cy: -60, r: 10 }, secondHand);
    svgEl("circle", { r: 2.4 }, secondHand);

    const select = fig.querySelector(".pick");
    const i = swiss.length;
    select.addEventListener("change", () => {
      state.clocks[i] = select.value;
      save();
      tick();
    });
    swiss.push({ root: fig, hourHand, minuteHand, secondHand, select, info: fig.querySelector(".info"), offsetMs: 0 });
  }
}

// The saved city for clock i, or a sensible default when it was removed.
function clockCity(i) {
  const picked = state.cities.find((c) => idOf(c) === state.clocks[i]);
  if (picked) return picked;
  const local = state.cities.find((c) => c.tz === LOCAL_TZ);
  const first = local || state.cities[0];
  const fallback = i === 0 ? first : state.cities.find((c) => c !== clockCity(0)) || first;
  return fallback || { name: "Local time", country: "", tz: LOCAL_TZ };
}

function renderClockPickers() {
  swiss.forEach((clk, i) => {
    clk.select.textContent = "";
    const current = clockCity(i);
    const options = state.cities.length ? state.cities : [current];
    for (const c of options) {
      const opt = document.createElement("option");
      opt.value = idOf(c);
      opt.textContent = c.name;
      clk.select.appendChild(opt);
    }
    clk.select.value = idOf(current);
    clk.select.disabled = state.cities.length === 0;
  });
}

function updateClockInfo(now) {
  const local = zoneParts(LOCAL_TZ, now);
  const localDay = Date.UTC(local.year, local.month - 1, local.day);
  const localOff = offsetMinutes(LOCAL_TZ, now);
  swiss.forEach((clk, i) => {
    const c = clockCity(i);
    const off = offsetMinutes(c.tz, now);
    clk.offsetMs = off * 60000;
    const p = zoneParts(c.tz, now);
    const dayDiff = Math.round((Date.UTC(p.year, p.month - 1, p.day) - localDay) / 86400000);
    const rel = dayDiff === 1 ? "Tomorrow, " : dayDiff === -1 ? "Yesterday, " : "";
    const diff = c.tz === LOCAL_TZ ? "your time" : fmtDiff(off - localOff);
    clk.info.textContent = `${isNight(p.hour) ? "☾" : "☀"} ${rel}${p.weekday} · ${diff}`;
    clk.root.classList.toggle("night", isNight(p.hour));
  });
}

// SBB "stop-to-go": the second hand sweeps round in 58.5 s, rests at 12,
// and the minute hand jumps once it is released.
function animateClocks() {
  const nowMs = Date.now();
  for (const clk of swiss) {
    const t = new Date(nowMs + clk.offsetMs);   // wall clock of that city, read via UTC getters
    const h = t.getUTCHours(), m = t.getUTCMinutes();
    const msInMinute = t.getUTCSeconds() * 1000 + t.getUTCMilliseconds();
    const sec = Math.min(msInMinute / 58500, 1) * 360;
    clk.secondHand.setAttribute("transform", `rotate(${sec})`);
    clk.minuteHand.setAttribute("transform", `rotate(${m * 6})`);
    clk.hourHand.setAttribute("transform", `rotate(${(h % 12) * 30 + m * 0.5})`);
  }
  requestAnimationFrame(animateClocks);
}

// ---------- Main loop ----------

function tick() {
  const now = new Date();
  const utc = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}:${String(now.getUTCSeconds()).padStart(2, "0")}`;
  $("utcReadout").textContent = `UTC ${utc}`;
  renderColumn(now);
  updateListTimes(now);
  updateClockInfo(now);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

async function init() {
  const saved = await store.get();
  state.cities = Array.isArray(saved.cities)
    ? saved.cities.filter((c) => c && resolveTz(c.tz)).map((c) => ({ ...c, tz: resolveTz(c.tz) }))
    : defaultCities();
  state.hour12 = !!saved.hour12;
  state.clocks = Array.isArray(saved.clocks) ? saved.clocks.slice(0, 2) : [];
  if (!Array.isArray(saved.cities)) save();

  const toggle = $("formatToggle");
  toggle.textContent = state.hour12 ? "12h" : "24h";
  toggle.addEventListener("click", () => {
    state.hour12 = !state.hour12;
    toggle.textContent = state.hour12 ? "12h" : "24h";
    save();
    tick();
  });

  buildColumn();
  buildSwissClocks();
  wireColumnDrag();
  wireList();
  wireSearch();

  // Start with your own time zone facing you, as if standing at Alexanderplatz.
  const now = new Date();
  const k = faceFor(zoneParts(LOCAL_TZ, now).hour, now.getUTCHours());
  state.rotation = (k + 11) * FACE_DEG;
  const cyl = $("cylinder");
  cyl.style.transition = "none";   // open already facing you, no spin-in
  applyRotation();
  cyl.getBoundingClientRect();
  cyl.style.transition = "";

  // The atom model turns once a minute; start it where the real one would be.
  $("atom").setCurrentTime((Date.now() % 60000) / 1000);

  renderList();
  setInterval(tick, 1000);
  requestAnimationFrame(animateClocks);
}

init();
