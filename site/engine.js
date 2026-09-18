// engine.js - Oklahoma Fire Detections.
//
// Loads data/manifest.json, then the binary detection chunks a date range
// needs, and draws them with MapLibre. Every count on the page is taken from
// the same scan of the same rows, so the map, the tiles, the sensor list and
// the county list always describe the same selection. The timeline is drawn
// from the manifest's daily series, which 04_build_map_data.R counted from
// those same rows.

import * as maplibregl from "./assets/vendor/maplibre-gl-6.10.0/maplibre-gl.mjs";

window.OKF_ENGINE_LOADED = true;

const DAY_MS = 86400000;
// Above this many detections, individual points stop being readable and the
// GeoJSON hand-off to the worker takes seconds, so the map draws density.
const POINT_CAP = 150000;
const REFRESH_MS = 10 * 60 * 1000;
// Playback advances a clock through the selected dates and shows what was
// detected in the trailing 12 hours, older detections fading. A detection is a
// snapshot, and a fire stays on the map only while a satellite keeps seeing it:
// GOES scans every 5 minutes but can miss a burning fire for hours (the Oilton
// fire of 14 March 2025 went undetected from 7:30 PM to 2 AM under an active
// warning), and each VIIRS satellite passes only about twice a day. Twelve
// hours bridges the gap between VIIRS passes.
const PLAY_TRAIL_MIN = 720;
const PLAY_FRAME_MS = 80;
const OK_BOUNDS = [[-103.0, 33.6], [-94.4, 37.0]];

// Palettes ---------------------------------------------------------------------
// Validated with the dataviz palette checks against each base map's own
// background (#0e0e0e dark, #fafaf8 light). Intensity is one orange hue, ordered
// so the strongest fires have the most contrast with the map beneath them:
// brightest on dark maps, darkest on light ones. Sensor colors are the first
// three categorical slots, the most that stay distinguishable on a map.
const PALETTE = {
  dark: {
    frp: ["#b0530a", "#e07227", "#ffa069", "#ffd8c3"],
    none: "#8f8d86",
    ring: "#0e0e0e",
    sensor: ["#3987e5", "#d95926", "#199e70"],
    choro: ["#a54c01", "#cb6620", "#ee8545", "#feaf82", "#ffddca"],
    // Fire warnings: violet, the categorical slot farthest from every orange
    // intensity step in both modes (OKLab distance 24 or more, all vision types).
    warn: "#9085e9",
    // Wireless Emergency Alerts: aqua, 17 or more from the violet and 8.6 or
    // more from every intensity step under simulated color-vision deficiency.
    wea: "#199e70",
    countyLine: "rgba(255,255,255,0.22)",
    stateLine: "rgba(255,255,255,0.75)",
    hover: "#ffffff",
  },
  light: {
    frp: ["#ff9a5f", "#dd6f23", "#ad5003", "#7b3600"],
    none: "#9a988f",
    ring: "#fafaf8",
    sensor: ["#2a78d6", "#eb6834", "#1baf7a"],
    choro: ["#ff9a5f", "#e7792f", "#c65e0b", "#a04a03", "#7b3600"],
    warn: "#4a3aa7",
    wea: "#0f7f5a",
    countyLine: "rgba(40,30,20,0.25)",
    stateLine: "rgba(40,30,20,0.8)",
    hover: "#1c1b19",
  },
};

const FRP_CLASSES = [
  { label: "Under 10 MW", test: (f) => f < 10 },
  { label: "10 to 50 MW", test: (f) => f < 50 },
  { label: "50 to 100 MW", test: (f) => f < 100 },
  { label: "100 MW or more", test: () => true },
];
const NOT_MEASURED = 4;

const SENSOR_GROUPS = [
  { label: "GOES", families: ["goes"] },
  { label: "VIIRS", families: ["viirs"] },
  { label: "MODIS, AVHRR and analyst-added", families: ["modis", "avhrr", "analyst"] },
];

// Pixels each alert outline is nudged off the line it is drawn on, so a
// warning and a WEA sharing a polygon stay separately visible.
const WARN_OFFSET = 1.5;

const CARTO = "https://basemaps.cartocdn.com/gl/";
const BASEMAPS = {
  dark: { label: "Dark", tone: "dark", style: CARTO + "dark-matter-gl-style/style.json" },
  light: { label: "Light", tone: "light", style: CARTO + "positron-gl-style/style.json" },
  streets: { label: "Streets", tone: "light", style: CARTO + "voyager-gl-style/style.json" },
  satellite: {
    label: "Satellite",
    tone: "dark",
    style: {
      version: 8,
      sources: {
        imagery: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          maxzoom: 19,
          attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
        },
        labels: {
          type: "raster",
          tiles: ["https://basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
        },
      },
      layers: [
        { id: "imagery", type: "raster", source: "imagery" },
        { id: "sat-labels", type: "raster", source: "labels" },
      ],
    },
  },
};

const PRESETS = [
  { id: "1d", label: "Latest day", len: 1 },
  { id: "7d", label: "7 days", len: 7 },
  { id: "30d", label: "30 days", len: 30 },
  { id: "90d", label: "90 days", len: 90 },
  { id: "ytd", label: "Year to date" },
  { id: "12m", label: "12 months", len: 365 },
  { id: "all", label: "All years" },
];

// State ------------------------------------------------------------------------
const state = {
  start: 0,
  end: 0,
  preset: "30d",
  view: "points",
  colorBy: "frp",
  basemap: "dark",
  minFrp: 0,
  families: null, // Set of family ids switched on
  zoom: "year",
  playing: false,
  // The playback clock, in minutes since 1970 UTC. Set means the map shows the
  // trailing window ending there rather than the whole period, whether the
  // clock is running or stepped by hand.
  clock: null,
  showWarnings: true,
  showWeas: true,
};

let manifest = null;
let epochMs = 0;
let tz = "America/Chicago";
let famIds = [];
let srcFamily = null; // source index -> family index
let srcGroup = null; // source index -> sensor color group
let unavailableDays = new Set();
let truncatedDays = new Set();
let countyGeo = null;
let current = null; // the last selection drawn
let lastChecked = Date.now();
let styleReady = false;
let mapData = { points: emptyFC(), heat: emptyFC() };
let heatRef = 1;
let heatK = 0.2;
let countyBins = null;
let showAllCounties = false;
let showAllWarnings = false;
let warningGeo = null; // FeatureCollection from 05_build_warnings.R
let warningText = null; // full product text, fetched on first request
let weaGeo = null; // FeatureCollection from 06_build_weas.R
let showAllWeas = false;

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-US");
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function emptyFC() {
  return { type: "FeatureCollection", features: [] };
}

// Dates ------------------------------------------------------------------------
// Day indexes count Oklahoma calendar days from the epoch. They are handled as
// UTC midnights so that no browser time zone can shift a date by one.
const dayDate = (d) => new Date(epochMs + d * DAY_MS);
const iso = (d) => dayDate(d).toISOString().slice(0, 10);
const isoToDay = (s) => Math.round((Date.parse(s + "T00:00:00Z") - epochMs) / DAY_MS);
const fmtDay = (d, o = {}) =>
  dayDate(d).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", ...o });
const fmtLocal = (ms, o) => new Date(ms).toLocaleString("en-US", { timeZone: tz, ...o });
const clampDay = (d) => Math.max(0, Math.min(manifest.latest_day, d));

function fmtRange(a, b) {
  if (a === b) return fmtDay(a, { weekday: "short" });
  const da = dayDate(a), db = dayDate(b);
  const sameYear = da.getUTCFullYear() === db.getUTCFullYear();
  return `${fmtDay(a, sameYear ? { year: undefined } : {})} – ${fmtDay(b)}`;
}

function compact(n) {
  if (n >= 1e6) return nf1.format(n / 1e6) + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "k";
  if (n >= 1e3) return nf1.format(n / 1e3) + "k";
  return nf.format(n);
}

// Manifest ---------------------------------------------------------------------
async function fetchManifest() {
  const r = await fetch(`data/manifest.json?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status}`);
  return r.json();
}

function applyManifest(m) {
  const keep = new Set(m.chunks.map((c) => c.file));
  for (const file of chunkCache.keys()) if (!keep.has(file)) chunkCache.delete(file);

  manifest = m;
  epochMs = Date.parse(m.epoch + "T00:00:00Z");
  tz = m.timezone;
  famIds = m.families.map((f) => f.family);
  srcFamily = Uint8Array.from(m.sources, (s) => famIds.indexOf(s.family));
  srcGroup = Uint8Array.from(m.sources, (s) => SENSOR_GROUPS.findIndex((g) => g.families.includes(s.family)));
  // A missing NOAA file for day D mostly holds detections from Oklahoma day D.
  unavailableDays = new Set(m.unavailable_days.map(isoToDay));
  truncatedDays = new Set((m.truncated_days || []).map(isoToDay));
  if (!state.families) state.families = new Set(famIds);
  buildCumulative();
}

// Prefix sums of the daily series over the families switched on, so any bin of
// the timeline is two lookups.
let cumulative = null;
function buildCumulative() {
  const n = manifest.latest_day + 1;
  cumulative = new Float64Array(n + 1);
  const on = famIds.filter((f) => state.families.has(f)).map((f) => manifest.daily[f]);
  for (let d = 0; d < n; d++) {
    let s = 0;
    for (const series of on) s += series[d];
    cumulative[d + 1] = cumulative[d] + s;
  }
}
const countDays = (a, b) => cumulative[clampDay(b) + 1] - cumulative[clampDay(a)];

// Chunks -----------------------------------------------------------------------
// Each chunk is columnar: typed-array views straight onto the downloaded
// buffer, laid out as 04_build_map_data.R documents. Names carry a content
// hash, so a cached chunk is never stale.
const chunkCache = new Map();
const chunkReady = new Map();

function loadChunk(meta) {
  if (!chunkCache.has(meta.file)) {
    const p = fetch("data/" + meta.file)
      .then((r) => {
        if (!r.ok) throw new Error(`${meta.file}: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        const n = meta.n;
        if (buf.byteLength !== n * 20) throw new Error(`${meta.file} is ${buf.byteLength} bytes, expected ${n * 20}`);
        const c = {
          meta, n,
          lon: new Float32Array(buf, 0, n),
          lat: new Float32Array(buf, 4 * n, n),
          frp: new Float32Array(buf, 8 * n, n),
          minute: new Uint32Array(buf, 12 * n, n),
          day: new Uint16Array(buf, 16 * n, n),
          src: new Uint8Array(buf, 18 * n, n),
          county: new Uint8Array(buf, 19 * n, n),
        };
        chunkReady.set(meta.file, true);
        return c;
      });
    p.catch(() => { chunkCache.delete(meta.file); });
    chunkCache.set(meta.file, p);
  }
  return chunkCache.get(meta.file);
}

const chunksFor = (a, b) => manifest.chunks.filter((c) => c.last_day >= a && c.first_day <= b);

function lowerBound(arr, n, v) {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Selection --------------------------------------------------------------------
function frpClass(f) {
  if (!(f >= 0)) return NOT_MEASURED;
  for (let k = 0; k < FRP_CLASSES.length; k++) if (FRP_CLASSES[k].test(f)) return k;
  return 3;
}

function passesFrp(f) {
  if (state.minFrp === 0) return true;
  if (state.minFrp === 1) return f >= 0;
  return f >= state.minFrp;
}

function select(loaded, a, b) {
  const famOn = famIds.map((f) => state.families.has(f));
  const sel = {
    a, b, loaded,
    rowK: [], rowI: [],
    total: 0,
    byDay: new Int32Array(b - a + 1),
    byCounty: new Int32Array(manifest.counties.length + 1),
    byFamily: new Int32Array(famIds.length),
    byClass: new Int32Array(5),
    byGroup: new Int32Array(SENSOR_GROUPS.length),
    maxFrp: -1, maxAt: null,
  };
  loaded.forEach((c, k) => {
    for (let i = lowerBound(c.day, c.n, a); i < c.n && c.day[i] <= b; i++) {
      const f = c.frp[i];
      if (!passesFrp(f)) continue;
      const fam = srcFamily[c.src[i]];
      sel.byFamily[fam]++;
      if (!famOn[fam]) continue;
      sel.rowK.push(k);
      sel.rowI.push(i);
      sel.total++;
      sel.byDay[c.day[i] - a]++;
      sel.byCounty[c.county[i]]++;
      sel.byClass[frpClass(f)]++;
      sel.byGroup[srcGroup[c.src[i]]]++;
      if (f > sel.maxFrp) { sel.maxFrp = f; sel.maxAt = [k, i]; }
    }
  });
  return sel;
}

function activeRange() {
  return [state.start, state.end];
}

// Warnings in force on any day of a range: issued on or before its last day
// and expiring on or after its first. Days are Oklahoma days, as for detections.
function warningsIn(a, b) {
  return warningGeo.features.filter((f) => f.properties.d0 <= b && f.properties.d1 >= a);
}

function weasIn(a, b) {
  return weaGeo.features.filter((f) => f.properties.d0 <= b && f.properties.d1 >= a);
}

async function fetchWarnings(build, file = "warnings.geojson") {
  const r = await fetch(`data/${file}?v=${build}`);
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  const fc = await r.json();
  fc.features.forEach((f, i) => { f.id = i; });
  return fc;
}

// Update -----------------------------------------------------------------------
let token = 0;
async function update(retried = false) {
  const my = ++token;
  syncControls();
  drawTimeline();
  writeHash();
  const [a, b] = activeRange();
  const metas = chunksFor(a, b);
  const pending = metas.filter((m) => !chunkReady.has(m.file));
  if (pending.length) {
    $("busy-text").textContent = pending.map((m) => m.id).join(", ");
    $("busy").hidden = false;
    $("tiles").classList.add("pending");
  }
  let loaded;
  try {
    loaded = await Promise.all(metas.map(loadChunk));
  } catch (e) {
    if (my !== token) return;
    // Each deploy replaces the chunks with newly hashed names, so a page open
    // across a deploy can ask for a file that is gone. Pick up the new
    // manifest and try once more before reporting a failure.
    if (!retried && /HTTP 404/.test(e.message)) {
      await checkForUpdate({ quiet: true });
      if (my === token) return update(true);
      return;
    }
    $("busy").hidden = true;
    toast("Could not load detections: " + e.message, 8000);
    return;
  }
  if (my !== token) return;
  $("busy").hidden = true;
  $("tiles").classList.remove("pending");
  current = select(loaded, a, b);
  renderMap();
  renderTiles();
  renderFamilies();
  renderCounties();
  renderWarnings();
  renderWeas();
  renderLegend();
}

// Map --------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map",
  style: BASEMAPS.dark.style,
  bounds: OK_BOUNDS,
  fitBoundsOptions: { padding: { top: 50, bottom: 170, left: 30, right: 30 } },
  minZoom: 4,
  maxZoom: 16,
  attributionControl: { compact: true },
  canvasContextAttributes: { preserveDrawingBuffer: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new maplibregl.FullscreenControl({ container: $("stage") }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");

const tone = () => BASEMAPS[state.basemap].tone;

function effectiveView() {
  if (state.clock != null) return "points";
  if (state.view === "points" && current && current.total > POINT_CAP) return "heat";
  return state.view;
}

function addOverlays() {
  const P = PALETTE[tone()];
  const layers = map.getStyle().layers;
  const firstSymbol = layers.find((l) => l.type === "symbol" || l.id === "sat-labels");
  const before = firstSymbol ? firstSymbol.id : undefined;

  if (!map.getSource("okf-counties")) {
    map.addSource("okf-counties", { type: "geojson", data: countyGeo, promoteId: "county" });
  }
  map.addSource("okf-state", { type: "geojson", data: "data/state.geojson" });
  map.addSource("okf-points", { type: "geojson", data: mapData.points, buffer: 16 });
  map.addSource("okf-heat", { type: "geojson", data: mapData.heat });
  map.addSource("okf-warnings", { type: "geojson", data: warningGeo });
  map.addSource("okf-weas", { type: "geojson", data: weaGeo });

  map.addLayer({
    id: "okf-county-fill", type: "fill", source: "okf-counties",
    paint: { "fill-color": choroplethColor(P), "fill-opacity": 0.8 },
  }, before);
  map.addLayer({
    id: "okf-heat", type: "heatmap", source: "okf-heat",
    paint: heatPaint(P),
  }, before);
  map.addLayer({
    id: "okf-county-line", type: "line", source: "okf-counties",
    paint: { "line-color": P.countyLine, "line-width": 0.6 },
  }, before);
  map.addLayer({
    id: "okf-state-line", type: "line", source: "okf-state",
    paint: { "line-color": P.stateLine, "line-width": 1.6 },
  }, before);
  // Warnings sit under the detections so a fire inside a warning stays visible.
  // A warning drawn from whole counties, with no polygon of its own, is dashed.
  map.addLayer({
    id: "okf-warn-fill", type: "fill", source: "okf-warnings",
    paint: { "fill-color": P.warn, "fill-opacity": 0.14 },
  }, before);
  // A sender often sends a WEA for the exact polygon of the warning it
  // accompanies - 28 of 119 overlapping pairs. Drawn on the same line the aqua
  // would hide the violet entirely, so the two are nudged a pixel and a half
  // apart, the warning outward and the WEA inward, and identical areas read as
  // a double ring.
  map.addLayer({
    id: "okf-warn-line", type: "line", source: "okf-warnings",
    paint: { "line-color": P.warn, "line-width": 2.2, "line-offset": WARN_OFFSET },
  }, before);
  map.addLayer({
    id: "okf-warn-county", type: "line", source: "okf-warnings",
    paint: {
      "line-color": P.warn, "line-width": 2,
      "line-dasharray": [2, 1.5], "line-offset": WARN_OFFSET,
    },
  }, before);
  // WEAs above warnings: their polygons are usually smaller, drawn around one
  // town or neighborhood inside the warned area.
  map.addLayer({
    id: "okf-wea-fill", type: "fill", source: "okf-weas",
    paint: { "fill-color": P.wea, "fill-opacity": 0.16 },
  }, before);
  map.addLayer({
    id: "okf-wea-line", type: "line", source: "okf-weas",
    paint: { "line-color": P.wea, "line-width": 2.2, "line-offset": -WARN_OFFSET },
  }, before);
  map.addLayer({
    id: "okf-wea-county", type: "line", source: "okf-weas",
    paint: {
      "line-color": P.wea, "line-width": 2,
      "line-dasharray": [2, 1.5], "line-offset": -WARN_OFFSET,
    },
  }, before);
  map.addLayer({
    id: "okf-points", type: "circle", source: "okf-points",
    layout: { "circle-sort-key": ["match", ["get", "c"], NOT_MEASURED, -1, ["get", "c"]] },
    paint: pointPaint(P),
  }, before);
  map.addLayer({
    id: "okf-county-hover", type: "line", source: "okf-counties",
    paint: {
      "line-color": P.hover,
      "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 2.2, 0],
    },
  });
  styleReady = true;
  applyCountyState();
  setVisibility();
  applyWarningFilter();
}

const WARNING_LAYERS = ["okf-warn-fill", "okf-warn-line", "okf-warn-county"];
const WEA_LAYERS = ["okf-wea-fill", "okf-wea-line", "okf-wea-county"];

// Which warnings and WEAs the map draws: those in force during the selected
// dates, or at the clock during playback.
function applyWarningFilter() {
  if (!styleReady) return;
  const when = state.clock != null
    ? ["all", ["<=", ["get", "t0"], state.clock], [">=", ["get", "t1"], state.clock]]
    : ["all", ["<=", ["get", "d0"], state.end], [">=", ["get", "d1"], state.start]];
  const layers = [["okf-warn", WARNING_LAYERS, state.showWarnings], ["okf-wea", WEA_LAYERS, state.showWeas]];
  for (const [prefix, ids, on] of layers) {
    map.setFilter(`${prefix}-fill`, when);
    map.setFilter(`${prefix}-line`, ["all", when, ["==", ["get", "polygon"], true]]);
    map.setFilter(`${prefix}-county`, ["all", when, ["==", ["get", "polygon"], false]]);
    for (const id of ids) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  }
}

function pointPaint(P) {
  const radius = (s) => ["match", ["get", "c"], 0, 1.7 * s, 1, 2.3 * s, 2, 3.0 * s, 3, 3.8 * s, 2.0 * s];
  return {
    "circle-color": state.colorBy === "frp"
      ? ["match", ["get", "c"], 0, P.frp[0], 1, P.frp[1], 2, P.frp[2], 3, P.frp[3], P.none]
      : ["match", ["get", "g"], 0, P.sensor[0], 1, P.sensor[1], P.sensor[2]],
    "circle-radius": ["interpolate", ["exponential", 1.5], ["zoom"], 5, radius(1), 9, radius(2), 13, radius(4)],
    // `a` is a detection's age within the playback window, 0 to 1; outside
    // playback it is absent and nothing fades. A 12-hour-old detection keeps
    // 40% of its opacity, so a fire not seen since morning is still visible.
    "circle-opacity": [
      "*",
      ["match", ["get", "c"], NOT_MEASURED, 0.8, 0.95],
      ["-", 1, ["*", 0.6, ["coalesce", ["get", "a"], 0]]],
    ],
    "circle-stroke-color": P.ring,
    "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 5, 0.3, 10, 1],
    "circle-stroke-opacity": 0.7,
  };
}

function heatPaint(P) {
  const alpha = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  };
  return {
    "heatmap-weight": ["get", "w"],
    "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 5, heatK, 8, heatK * 2.5, 12, heatK * 7.5],
    "heatmap-radius": ["interpolate", ["exponential", 1.6], ["zoom"], 4, 4, 7, 9, 10, 24, 14, 70],
    "heatmap-color": [
      "interpolate", ["linear"], ["heatmap-density"],
      0, "rgba(0,0,0,0)",
      0.05, alpha(P.frp[0], 0.45),
      0.3, P.frp[1],
      0.6, P.frp[2],
      0.9, P.frp[3],
    ],
    "heatmap-opacity": 0.92,
  };
}

function choroplethColor(P) {
  return [
    "match", ["coalesce", ["feature-state", "bin"], -1],
    0, P.choro[0], 1, P.choro[1], 2, P.choro[2], 3, P.choro[3], 4, P.choro[4],
    "rgba(0,0,0,0)",
  ];
}

function restyleOverlays() {
  if (!styleReady) return;
  const P = PALETTE[tone()];
  for (const [k, v] of Object.entries(pointPaint(P))) map.setPaintProperty("okf-points", k, v);
  for (const [k, v] of Object.entries(heatPaint(P))) map.setPaintProperty("okf-heat", k, v);
  map.setPaintProperty("okf-county-fill", "fill-color", choroplethColor(P));
  map.setPaintProperty("okf-county-line", "line-color", P.countyLine);
  map.setPaintProperty("okf-state-line", "line-color", P.stateLine);
  map.setPaintProperty("okf-county-hover", "line-color", P.hover);
  map.setPaintProperty("okf-warn-fill", "fill-color", P.warn);
  map.setPaintProperty("okf-warn-line", "line-color", P.warn);
  map.setPaintProperty("okf-warn-county", "line-color", P.warn);
  map.setPaintProperty("okf-wea-fill", "fill-color", P.wea);
  map.setPaintProperty("okf-wea-line", "line-color", P.wea);
  map.setPaintProperty("okf-wea-county", "line-color", P.wea);
}

function setVisibility() {
  if (!styleReady) return;
  const v = effectiveView();
  const show = (id, on) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  show("okf-points", v === "points");
  show("okf-heat", v === "heat");
  show("okf-county-fill", v === "counties");
  map.setPaintProperty("okf-county-line", "line-width", v === "counties" ? 0.9 : 0.6);
}

function renderMap() {
  const sel = current;
  const v = effectiveView();
  const data = mapData;

  if (v === "points") {
    const features = new Array(sel.total);
    for (let j = 0; j < sel.total; j++) {
      const c = sel.loaded[sel.rowK[j]], i = sel.rowI[j];
      features[j] = {
        type: "Feature",
        id: j,
        geometry: { type: "Point", coordinates: [c.lon[i], c.lat[i]] },
        properties: { c: frpClass(c.frp[i]), g: srcGroup[c.src[i]] },
      };
    }
    data.points = { type: "FeatureCollection", features };
    data.heat = emptyFC();
  } else if (v === "heat") {
    data.points = emptyFC();
    data.heat = heatFeatures(sel);
  } else {
    data.points = emptyFC();
    data.heat = emptyFC();
  }
  countyBins = computeCountyBins(sel);

  if (!styleReady) return;
  map.getSource("okf-points").setData(data.points);
  map.getSource("okf-heat").setData(data.heat);
  map.setPaintProperty("okf-heat", "heatmap-intensity", heatPaint(PALETTE[tone()])["heatmap-intensity"]);
  applyCountyState();
  setVisibility();
  applyWarningFilter();
  popup.remove();
}

// Density is drawn from a 0.02-degree grid (about 2 km) rather than raw
// points: the same picture at the zooms a heat map is useful for, at a fraction
// of the features. Weights are scaled to the 99th percentile cell so one flare
// stack cannot wash out the state, and compressed so a county of scattered
// grass fires still shows beside it.
function heatFeatures(sel) {
  const cell = 0.02;
  const cells = new Map();
  for (let j = 0; j < sel.total; j++) {
    const c = sel.loaded[sel.rowK[j]], i = sel.rowI[j];
    const key = Math.floor((c.lon[i] + 180) / cell) * 100000 + Math.floor((c.lat[i] + 90) / cell);
    cells.set(key, (cells.get(key) || 0) + 1);
  }
  const counts = [...cells.values()].sort((x, y) => x - y);
  heatRef = Math.max(3, counts[Math.floor(counts.length * 0.99)] || 1);
  // Density adds up across neighbouring cells, so a week of scattered fires
  // needs far more intensity than a year to be seen at all. Scaled to the
  // number of occupied cells: about 0.2 for a year statewide, capped for a day.
  heatK = Math.min(2, Math.max(0.12, 22 / Math.sqrt(Math.max(1, cells.size))));
  const features = [];
  for (const [key, n] of cells) {
    const ix = Math.floor(key / 100000), iy = key % 100000;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [(ix + 0.5) * cell - 180, (iy + 0.5) * cell - 90] },
      properties: { w: Math.min(1, Math.sqrt(n / heatRef)) },
    });
  }
  return { type: "FeatureCollection", features };
}

// Counties are shaded by detections per 100 square miles, not raw counts: a
// raw count mostly measures county size. Breaks are quintiles of the counties
// that had any detections, rounded to readable numbers.
function computeCountyBins(sel) {
  const rates = manifest.counties.map((c) => ({
    id: c.id, n: sel.byCounty[c.id], rate: (sel.byCounty[c.id] / c.sq_mi) * 100,
  }));
  const nonzero = rates.filter((r) => r.n > 0).map((r) => r.rate).sort((x, y) => x - y);
  // Two significant figures: coarser rounding collapses neighbouring
  // quintiles onto the same break and leaves shades of the ramp unused.
  const nice = (x) => {
    if (x <= 0) return 0;
    const p = Math.pow(10, Math.floor(Math.log10(x)) - 1);
    return Math.round(x / p) * p;
  };
  const breaks = [];
  if (nonzero.length) {
    for (const q of [0.2, 0.4, 0.6, 0.8]) {
      const b = nice(nonzero[Math.floor(q * (nonzero.length - 1))]);
      if (b > 0 && (breaks.length === 0 || b > breaks[breaks.length - 1])) breaks.push(b);
    }
  }
  const binOf = (r) => {
    if (r.n === 0) return -1;
    let k = 0;
    while (k < breaks.length && r.rate >= breaks[k]) k++;
    // Spread the bins used across the ramp's full length when there are
    // fewer than five, so two bins are not two nearly identical oranges.
    return breaks.length >= 4 ? k : Math.round((k * 4) / Math.max(1, breaks.length));
  };
  return { breaks, rates, bin: new Map(rates.map((r) => [r.id, binOf(r)])) };
}

function applyCountyState() {
  if (!styleReady || !countyBins) return;
  for (const c of manifest.counties) {
    map.setFeatureState({ source: "okf-counties", id: c.id }, { bin: countyBins.bin.get(c.id) });
  }
}

// Map Interaction --------------------------------------------------------------
const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px", offset: 8 });
const hoverTip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: "okf-hover" });
let hoveredCounty = null;

map.on("click", (e) => {
  if (!styleReady || !current || state.playing) return;
  const v = effectiveView();
  if (v === "points") {
    const pad = 8;
    const box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
    const ids = [...new Set(map.queryRenderedFeatures(box, { layers: ["okf-points"] }).map((f) => f.id))];
    if (ids.length) { showDetections(ids, e.lngLat); return; }
  }
  // A click that finds no detection opens the WEAs and warnings under it.
  const alerts = alertsAt(e.point);
  if (alerts.weas.length || alerts.warnings.length) {
    showAlerts(alerts, e.lngLat);
    return;
  }
  if (v === "counties") {
    const f = map.queryRenderedFeatures(e.point, { layers: ["okf-county-fill"] })[0];
    if (f) zoomToCounty(f.id);
  }
});

map.on("mousemove", (e) => {
  if (!styleReady) return;
  const v = effectiveView();
  if (v === "points") {
    const pad = 6;
    const hit = map.queryRenderedFeatures([[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]], { layers: ["okf-points"] });
    const alerts = !state.playing && alertsAt(e.point);
    map.getCanvas().style.cursor = hit.length || (alerts && alerts.any) ? "pointer" : "";
  } else {
    const alerts = !state.playing && alertsAt(e.point);
    map.getCanvas().style.cursor = alerts && alerts.any ? "pointer" : "";
  }
  if (v !== "counties" || !current) { clearHover(); return; }
  const f = map.queryRenderedFeatures(e.point, { layers: ["okf-county-fill", "okf-county-line"] })[0];
  if (!f) { clearHover(); return; }
  if (hoveredCounty !== f.id) {
    clearHover();
    hoveredCounty = f.id;
    map.setFeatureState({ source: "okf-counties", id: f.id }, { hover: true });
  }
  const c = manifest.counties[f.id - 1];
  const n = current.byCounty[f.id];
  const el = document.createElement("div");
  line(el, "pop-when", `${c.name} County`);
  line(el, "pop-frp", `${nf.format(n)} detection${n === 1 ? "" : "s"}`);
  line(el, "pop-meta", `${nf1.format((n / c.sq_mi) * 100)} per 100 sq mi`);
  hoverTip.setLngLat(e.lngLat).setDOMContent(el).addTo(map);
  map.getCanvas().style.cursor = "pointer";
});
map.on("mouseout", clearHover);

function clearHover() {
  if (hoveredCounty != null && styleReady) {
    map.setFeatureState({ source: "okf-counties", id: hoveredCounty }, { hover: false });
  }
  hoveredCounty = null;
  hoverTip.remove();
}

function line(parent, cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  parent.appendChild(d);
  return d;
}

function describe(k, i) {
  const c = current.loaded[k];
  const src = manifest.sources[c.src[i]];
  const fam = manifest.families[srcFamily[c.src[i]]];
  const ms = c.minute[i] * 60000;
  return {
    when: fmtLocal(ms, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
    frp: c.frp[i],
    sensor: fam.family === "analyst" ? `Analyst-added · ${src.satellite}` : `${fam.label} · ${src.satellite}`,
    county: manifest.counties[c.county[i] - 1].name + " County",
    lat: c.lat[i], lon: c.lon[i],
  };
}

function showDetections(ids, lngLat) {
  const rows = ids.map((j) => [current.rowK[j], current.rowI[j]]);
  rows.sort((x, y) => (current.loaded[y[0]].frp[y[1]] || -1) - (current.loaded[x[0]].frp[x[1]] || -1));
  const el = document.createElement("div");
  for (const [k, i] of rows.slice(0, 6)) {
    const d = describe(k, i);
    const item = document.createElement("div");
    item.className = "pop-item";
    line(item, "pop-frp", d.frp >= 0 ? `${nf1.format(d.frp)} MW` : "Intensity not measured");
    line(item, "pop-when", d.when);
    line(item, "pop-meta", d.sensor);
    line(item, "pop-meta", `${d.county} · ${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`);
    el.appendChild(item);
  }
  if (rows.length > 6) line(el, "pop-more", `and ${rows.length - 6} more here - zoom in to separate them`);
  popup.setLngLat(lngLat).setDOMContent(el).addTo(map);
}

function zoomToCounty(id) {
  const b = manifest.counties[id - 1].bbox;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: { top: 60, bottom: 180, left: 40, right: 40 }, maxZoom: 11 });
}

const fmtWarnTime = (minute) => fmtLocal(minute * 60000, {
  month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

function alertsAt(point) {
  const ids = (layer, on) => (on && styleReady
    ? [...new Set(map.queryRenderedFeatures(point, { layers: [layer] }).map((f) => f.id))]
    : []);
  const weas = ids("okf-wea-fill", state.showWeas);
  const warnings = ids("okf-warn-fill", state.showWarnings);
  return { weas, warnings, any: weas.length + warnings.length > 0 };
}

// WEAs first, then warnings, each newest first. A spot can sit under several
// of each on a bad day, so the popup scrolls rather than truncating.
function showAlerts({ weas, warnings }, lngLat) {
  const newest = (geo, ids) => ids.map((i) => geo.features[i]).sort((x, y) => y.properties.t0 - x.properties.t0);
  const el = document.createElement("div");
  for (const f of newest(weaGeo, weas)) el.appendChild(weaCard(f));
  for (const f of newest(warningGeo, warnings)) el.appendChild(warningCard(f));
  popup.setLngLat(lngLat).setDOMContent(el).addTo(map);
}

function weaCard(f) {
  const w = f.properties;
  const item = document.createElement("div");
  item.className = "pop-item";
  line(item, "pop-wea", "\u{1F4F1} Wireless Emergency Alert");
  line(item, "pop-when", `${fmtWarnTime(w.t0)} until ${fmtLocal(w.t1 * 60000, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`);
  if (w.ended === "cancelled") line(item, "pop-meta", `Cancelled early; set to run until ${fmtLocal(w.t_expires * 60000, { hour: "numeric", minute: "2-digit" })}`);
  if (w.ended === "updated") line(item, "pop-meta", "Replaced by an updated alert");
  line(item, "pop-phone", w.phone);
  line(item, "pop-meta", `${w.event} · ${w.county_names} ${w.counties.includes(",") ? "counties" : "County"}`);
  line(item, "pop-meta", `Sent through ${w.sender_name}`);
  if (!w.polygon) line(item, "pop-meta", "No polygon sent: shown as the whole county.");
  if (w.long && w.long !== w.phone) {
    const more = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "Longer message";
    const body = document.createElement("div");
    body.className = "pop-summary";
    body.textContent = w.long;
    more.append(sum, body);
    item.appendChild(more);
  }
  return item;
}

function warningCard(f) {
  const w = f.properties;
  const item = document.createElement("div");
  item.className = "pop-item";
  const head = line(item, "pop-warn", "\u26A0 Fire Warning");
  head.setAttribute("aria-label", "Fire Warning");
  line(item, "pop-when", `${fmtWarnTime(w.t0)} until ${fmtLocal(w.t1 * 60000, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`);
  line(item, "pop-meta", `${w.county_names} ${w.counties.includes(",") ? "counties" : "County"} · ${w.office_name}`);
  if (w.requested_by) line(item, "pop-meta", `Requested by ${w.requested_by}`);
  if (!w.polygon) line(item, "pop-meta", "No polygon issued: shown as the whole county.");
  line(item, "pop-summary", w.summary);
  const links = document.createElement("div");
  links.className = "pop-links";
  const more = document.createElement("button");
  more.type = "button";
  more.className = "link-btn";
  more.textContent = "Full text";
  more.addEventListener("click", async () => {
    more.disabled = true;
    try {
      if (!warningText) {
        const r = await fetch(`data/warning_text.json?v=${manifest.build}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        warningText = await r.json();
      }
      const pre = document.createElement("pre");
      pre.className = "pop-text";
      pre.textContent = (warningText[w.id] || "").trim();
      links.replaceWith(pre);
    } catch (err) {
      more.disabled = false;
      toast("Could not load the warning text: " + err.message);
    }
  });
  const iem = document.createElement("a");
  iem.href = w.url;
  iem.target = "_blank";
  iem.rel = "noopener";
  iem.textContent = "Original at IEM";
  links.append(more, iem);
  item.appendChild(links);
  return item;
}

function warningBounds(f) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]);
      y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]);
    } else c.forEach(walk);
  };
  walk(f.geometry.coordinates);
  return [[x0, y0], [x1, y1]];
}

function zoomToWarning(f, card = warningCard) {
  const b = warningBounds(f);
  map.fitBounds(b, { padding: { top: 80, bottom: 200, left: 60, right: 60 }, maxZoom: 11 });
  map.once("moveend", () => {
    popup.setLngLat([(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2])
      .setDOMContent(card(f)).addTo(map);
  });
}

map.on("moveend", () => writeHash());

// Base Maps --------------------------------------------------------------------
function setBasemap(id, { initial = false } = {}) {
  if (!BASEMAPS[id]) id = "dark";
  const changed = id !== state.basemap || initial;
  state.basemap = id;
  syncBasemapButtons();
  if (!changed) return;
  styleReady = false;
  currentStyleLoaded = false;
  usingFallback = false;
  clearHover();
  map.setStyle(BASEMAPS[id].style, { diff: false });
  writeHash();
}

// Every style load, the first included, wipes our sources and layers. The
// first one can finish before the manifest arrives, so overlays wait for both.
// If a base map's style cannot be fetched, fall back to a plain background so
// the detections, counties and state line still draw.
const FALLBACK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#0e0e0e" } }],
};
let usingFallback = false;
let currentStyleLoaded = false;
map.on("error", (e) => {
  const msg = String((e && e.error && e.error.message) || "");
  if (usingFallback || currentStyleLoaded || !/style|Failed to fetch|NetworkError|Load failed/i.test(msg)) return;
  usingFallback = true;
  toast("The base map could not load; showing detections on a plain background.", 6000);
  map.setStyle(FALLBACK_STYLE, { diff: false });
});

let firstStyleLoaded = false;
map.on("style.load", () => {
  firstStyleLoaded = true;
  currentStyleLoaded = true;
  if (!manifest || !countyGeo || !warningGeo || !weaGeo) return;
  addOverlays();
  if (current) renderMap();
});

function syncBasemapButtons() {
  for (const b of $("basemaps").children) b.setAttribute("aria-checked", String(b.dataset.basemap === state.basemap));
}

// Timeline ---------------------------------------------------------------------
const tl = { canvas: $("timeline"), drag: null, hover: null, colors: null, layout: null };

function readColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  tl.colors = { bar: v("--bar"), out: v("--bar-out"), grid: v("--grid"), muted: v("--muted"), text: v("--text"), accent: v("--accent"), warn: v("--warn"), wea: v("--wea") };
}

function timelineDomain() {
  const latest = manifest.latest_day;
  if (state.zoom === "all") return [0, latest];
  if (state.zoom === "year") {
    // The calendar year the range ends in, stretched back when the range
    // starts earlier so the selection is never cut off.
    const y = dayDate(state.end).getUTCFullYear();
    const a = Math.min(state.start, isoToDay(`${y}-01-01`)), b = isoToDay(`${y}-12-31`);
    return [Math.max(0, a), Math.min(latest, b)];
  }
  const len = state.end - state.start + 1;
  const pad = Math.max(10, Math.round(len * 0.25));
  return [Math.max(0, state.start - pad), Math.min(latest, state.end + pad)];
}

function drawTimeline() {
  if (!manifest) return;
  const cv = tl.canvas;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const C = tl.colors;

  const [d0, d1] = timelineDomain();
  const span = d1 - d0 + 1;
  const L = 38, R = 8, T = 12, B = 18;
  const pw = W - L - R, ph = H - T - B;
  const binDays = [1, 2, 7, 14, 28, 56, 91].find((k) => (pw / span) * k >= 2.5) || 91;
  const x = (d) => L + ((d - d0) / span) * pw;
  tl.layout = { d0, d1, span, L, R, T, B, pw, ph, binDays, x };

  const bins = [];
  let max = 0;
  for (let s = Math.floor(d0 / binDays) * binDays; s <= d1; s += binDays) {
    const a = Math.max(s, d0), b = Math.min(s + binDays - 1, d1);
    const v = countDays(a, b) * (binDays / (b - a + 1)); // partial edge bins scaled to a full bin
    bins.push({ s, a, b, v, raw: countDays(a, b) });
    if (v > max) max = v;
  }
  const niceMax = (() => {
    if (max <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(max)));
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= max);
  })();
  const y = (v) => T + ph - (v / niceMax) * ph;

  // Gridlines and y labels
  ctx.font = "11px " + getComputedStyle(document.body).fontFamily;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (const g of [niceMax / 2, niceMax]) {
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L, Math.round(y(g)) + 0.5);
    ctx.lineTo(W - R, Math.round(y(g)) + 0.5);
    ctx.stroke();
    ctx.fillStyle = C.muted;
    ctx.fillText(compact(g), L - 6, y(g));
  }

  // Selection band
  const [sa, sb] = [state.start, state.end];
  const sx0 = x(sa), sx1 = Math.max(x(sb + 1), sx0 + 3);
  ctx.fillStyle = C.accent;
  ctx.globalAlpha = 0.1;
  ctx.fillRect(sx0, T, sx1 - sx0, ph);
  ctx.globalAlpha = 1;

  // Bars
  for (const bin of bins) {
    const bx0 = x(bin.a), bx1 = x(bin.b + 1);
    const gap = bx1 - bx0 >= 4 ? 1 : 0;
    const top = y(bin.v);
    const hgt = T + ph - top;
    if (hgt <= 0) continue;
    const inSel = bin.b >= sa && bin.a <= sb;
    ctx.fillStyle = inSel ? C.bar : C.out;
    const w = Math.max(1, bx1 - bx0 - gap);
    const r = Math.min(2, w / 2, hgt);
    ctx.beginPath();
    ctx.roundRect(bx0, top, w, Math.max(hgt, 1), [r, r, 0, 0]);
    ctx.fill();
  }

  // Baseline, with NOAA's missing days marked beneath it
  ctx.fillStyle = C.out;
  ctx.fillRect(L, T + ph, pw, 1);
  ctx.fillStyle = C.muted;
  for (const d of unavailableDays) if (d >= d0 && d <= d1) ctx.fillRect(x(d), T + ph + 2, Math.max(1, pw / span), 3);

  // Selection edges
  ctx.fillStyle = C.accent;
  ctx.fillRect(sx0 - 1, T, 2, ph);
  ctx.fillRect(sx1 - 1, T, 2, ph);

  // Warnings and WEAs as ticks along the top edge, one per alert at the day it
  // was issued: warnings in the upper row, WEAs in the lower.
  const alertTicks = (geo, color, top) => {
    ctx.fillStyle = color;
    for (const f of geo.features) {
      const d = f.properties.d0;
      if (d < d0 || d > d1) continue;
      ctx.fillRect(Math.round(x(d + 0.5)) - 1, top, 2, 5);
    }
  };
  if (state.showWarnings) alertTicks(warningGeo, C.warn, 1);
  if (state.showWeas) alertTicks(weaGeo, C.wea, 6);

  // Play head
  if (state.clock != null) {
    const dayFloat = state.start + (state.clock - play.startMinute) / 1440;
    ctx.fillStyle = C.text;
    ctx.fillRect(x(dayFloat) - 1, T - 2, 2, ph + 4);
  }

  // X ticks
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const startDate = dayDate(d0);
  const ticks = [];
  if (span > 800) {
    for (let yr = startDate.getUTCFullYear(); ; yr++) {
      const d = isoToDay(`${yr}-01-01`);
      if (d > d1) break;
      if (d >= d0) ticks.push([d, String(yr)]);
    }
  } else if (span > 60) {
    const cur = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
    const step = span > 400 ? 3 : 1;
    while (true) {
      const d = Math.round((cur.getTime() - epochMs) / DAY_MS);
      if (d > d1) break;
      if (d >= d0 && cur.getUTCMonth() % step === 0) {
        const lab = cur.getUTCMonth() === 0
          ? String(cur.getUTCFullYear())
          : cur.toLocaleDateString("en-US", { timeZone: "UTC", month: "short" });
        ticks.push([d, lab]);
      }
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
  } else {
    const every = span > 21 ? 7 : span > 8 ? 2 : 1;
    for (let d = d0; d <= d1; d++) if ((d - d0) % every === 0) ticks.push([d, fmtDay(d, { year: undefined })]);
  }
  ctx.fillStyle = C.muted;
  let lastRight = -Infinity;
  for (const [d, lab] of ticks) {
    const tx = x(d);
    const w = ctx.measureText(lab).width;
    ctx.fillRect(tx, T + ph, 1, 4);
    if (tx + 3 > lastRight + 6 && tx + 3 + w < W) {
      ctx.fillText(lab, tx + 3, H - 3);
      lastRight = tx + 3 + w;
    }
  }

  const unit = { 1: "day", 2: "2 days", 7: "week", 14: "2 weeks", 28: "4 weeks", 56: "8 weeks", 91: "13 weeks" }[binDays];
  const allOn = state.families.size === famIds.length;
  const which = allOn ? "" : ` · ${famIds.filter((f) => state.families.has(f)).map((f) => manifest.families[famIds.indexOf(f)].label).join(", ") || "no sensors"}`;
  $("timeline-title").textContent = `Detections per ${unit}${which}`;
}

function dayAtX(px) {
  const { L, pw, d0, span } = tl.layout;
  return clampDay(Math.floor(d0 + ((px - L) / pw) * span));
}

tl.canvas.addEventListener("pointerdown", (e) => {
  if (!tl.layout) return;
  closeClock();
  const px = e.offsetX;
  const { x } = tl.layout;
  const edgeA = x(state.start), edgeB = x(state.end + 1);
  const d = dayAtX(px);
  if (Math.abs(px - edgeA) <= 6) tl.drag = { mode: "a" };
  else if (Math.abs(px - edgeB) <= 6) tl.drag = { mode: "b" };
  else if (px > edgeA && px < edgeB) tl.drag = { mode: "move", offset: d - state.start, len: state.end - state.start };
  else tl.drag = { mode: "new", anchor: d };
  tl.drag.moved = false;
  tl.canvas.setPointerCapture(e.pointerId);
  $("timeline-tip").hidden = true;
});

tl.canvas.addEventListener("pointermove", (e) => {
  if (!tl.layout) return;
  const d = dayAtX(e.offsetX);
  if (!tl.drag) { showTimelineTip(e.offsetX, e.offsetY); return; }
  const g = tl.drag;
  g.moved = true;
  if (g.mode === "new") [state.start, state.end] = [Math.min(g.anchor, d), Math.max(g.anchor, d)];
  else if (g.mode === "a") [state.start, state.end] = [Math.min(d, state.end), Math.max(d, state.end)];
  else if (g.mode === "b") [state.start, state.end] = [Math.min(state.start, d), Math.max(state.start, d)];
  else {
    const s = Math.max(0, Math.min(manifest.latest_day - g.len, d - g.offset));
    [state.start, state.end] = [s, s + g.len];
  }
  state.preset = null;
  syncDateControls();
  drawTimeline();
});

const endDrag = () => {
  if (!tl.drag) return;
  const g = tl.drag;
  tl.drag = null;
  if (g.mode === "new" && !g.moved) {
    // A click without a drag picks the bin under the pointer.
    const b = tl.layout.binDays;
    const s = Math.max(tl.layout.d0, Math.floor(g.anchor / b) * b);
    [state.start, state.end] = [s, clampDay(s + b - 1)];
    state.preset = null;
  }
  if (g.moved || g.mode === "new") update();
};
tl.canvas.addEventListener("pointerup", endDrag);
tl.canvas.addEventListener("pointercancel", endDrag);
tl.canvas.addEventListener("pointerleave", () => { if (!tl.drag) $("timeline-tip").hidden = true; });

tl.canvas.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  step(e.key === "ArrowLeft" ? -1 : 1, e.shiftKey ? null : 1);
});

function showTimelineTip(px, py) {
  const { binDays, d0, d1 } = tl.layout;
  const d = dayAtX(px);
  const s = Math.max(d0, Math.floor(d / binDays) * binDays);
  const e = Math.min(d1, s + binDays - 1);
  const n = countDays(s, e);
  const tip = $("timeline-tip");
  tip.textContent = "";
  const b = document.createElement("b");
  b.textContent = nf.format(n);
  tip.append(b, ` detection${n === 1 ? "" : "s"} · ${fmtRange(s, e)}`);
  if (binDays === 1 && unavailableDays.has(d)) tip.append(" · no NOAA file");
  if (binDays === 1 && truncatedDays.has(d)) tip.append(" · NOAA file cut off");
  const nWarn = state.showWarnings ? warningGeo.features.filter((f) => f.properties.d0 >= s && f.properties.d0 <= e).length : 0;
  if (nWarn) tip.append(` · ${nWarn} fire warning${nWarn === 1 ? "" : "s"}`);
  const nWea = state.showWeas ? weaGeo.features.filter((f) => f.properties.d0 >= s && f.properties.d0 <= e).length : 0;
  if (nWea) tip.append(` · ${nWea} WEA${nWea === 1 ? "" : "s"}`);
  tip.hidden = false;
  const W = tl.canvas.clientWidth;
  const tw = tip.offsetWidth;
  tip.style.left = Math.max(0, Math.min(W - tw, px - tw / 2)) + "px";
  tip.style.top = Math.max(-34, py - 40) + "px";
}

// Controls ---------------------------------------------------------------------
function applyPreset(id) {
  const latest = manifest.latest_day;
  const p = PRESETS.find((q) => q.id === id);
  if (p && p.len) [state.start, state.end] = [clampDay(latest - p.len + 1), latest];
  else if (id === "ytd") [state.start, state.end] = [clampDay(isoToDay(`${dayDate(latest).getUTCFullYear()}-01-01`)), latest];
  else if (id === "all") [state.start, state.end] = [0, latest];
  else if (/^y\d{4}$/.test(id)) {
    const yr = id.slice(1);
    [state.start, state.end] = [clampDay(isoToDay(`${yr}-01-01`)), clampDay(isoToDay(`${yr}-12-31`))];
  } else return false;
  state.preset = id;
  return true;
}

function buildControls() {
  const presets = $("presets");
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.label;
    b.dataset.preset = p.id;
    b.addEventListener("click", () => { closeClock(); applyPreset(p.id); if (state.zoom === "fit") state.zoom = "year"; update(); });
    presets.appendChild(b);
  }
  const ys = document.createElement("select");
  ys.id = "year-select";
  ys.setAttribute("aria-label", "Choose a year");
  const first = dayDate(0).getUTCFullYear(), last = dayDate(manifest.latest_day).getUTCFullYear();
  ys.add(new Option("Year…", ""));
  for (let yr = last; yr >= first; yr--) ys.add(new Option(String(yr), "y" + yr));
  ys.addEventListener("change", () => {
    if (!ys.value) return;
    closeClock();
    applyPreset(ys.value);
    update();
  });
  presets.appendChild(ys);

  const ds = $("date-start"), de = $("date-end");
  const onDate = () => {
    if (!ds.value || !de.value) return;
    closeClock();
    const a = clampDay(isoToDay(ds.value)), b = clampDay(isoToDay(de.value));
    [state.start, state.end] = [Math.min(a, b), Math.max(a, b)];
    state.preset = null;
    update();
  };
  ds.addEventListener("change", onDate);
  de.addEventListener("change", onDate);

  $("step-back").addEventListener("click", () => step(-1));
  $("step-fwd").addEventListener("click", () => step(1));
  $("play").addEventListener("click", () => (state.playing ? pausePlay() : startPlay()));
  $("clock-back").addEventListener("click", () => stepClock(-1));
  $("clock-fwd").addEventListener("click", () => stepClock(1));
  $("clock-first").addEventListener("click", jumpToFirstDetection);
  $("clock-exit").addEventListener("click", closeClock);
  $("play-step").addEventListener("change", () => { if (state.clock != null) syncControls(); });

  for (const b of $("view-seg").children) {
    b.addEventListener("click", () => { state.view = b.dataset.view; clearHover(); update(); });
  }
  for (const b of $("color-seg").children) {
    b.addEventListener("click", () => { state.colorBy = b.dataset.color; restyleOverlays(); syncControls(); renderLegend(); writeHash(); });
  }
  for (const b of $("zoom-seg").children) {
    b.addEventListener("click", () => { state.zoom = b.dataset.zoom; syncControls(); drawTimeline(); writeHash(); });
  }
  $("min-frp").addEventListener("change", (e) => { state.minFrp = Number(e.target.value); update(); });

  for (const [id, bm] of Object.entries(BASEMAPS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset.basemap = id;
    b.textContent = bm.label;
    b.addEventListener("click", () => setBasemap(id));
    $("basemaps").appendChild(b);
  }

  $("show-warnings").addEventListener("change", (e) => {
    state.showWarnings = e.target.checked;
    applyWarningFilter();
    drawTimeline();
    renderLegend();
    writeHash();
    if (!state.showWarnings) popup.remove();
  });
  $("show-weas").addEventListener("change", (e) => {
    state.showWeas = e.target.checked;
    applyWarningFilter();
    drawTimeline();
    renderLegend();
    writeHash();
    if (!state.showWeas) popup.remove();
  });
  $("wea-more").addEventListener("click", () => {
    showAllWeas = !showAllWeas;
    renderWeas();
  });
  $("warning-more").addEventListener("click", () => {
    showAllWarnings = !showAllWarnings;
    renderWarnings();
  });

  $("county-more").addEventListener("click", () => {
    showAllCounties = !showAllCounties;
    $("county-more").setAttribute("aria-expanded", String(showAllCounties));
    renderCounties();
  });

  $("copy-link").addEventListener("click", async () => {
    writeHash();
    try {
      await navigator.clipboard.writeText(location.href);
      toast("Link copied");
    } catch {
      toast("Copy the address bar to share this view");
    }
  });
  $("save-png").addEventListener("click", savePng);
  $("download-csv").addEventListener("click", downloadCsv);

  document.addEventListener("keydown", (e) => {
    // The target is the document itself when nothing has focus.
    const el = e.target instanceof Element ? e.target : null;
    if (el && el.closest("input, select, textarea, canvas")) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (el && el.closest(".maplibregl-canvas-container")) return;
      e.preventDefault();
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      // While the clock is open the arrows step it; otherwise they move the
      // dates, which is what they did before there was a clock.
      if (state.clock != null) stepClock(dir); else step(dir);
    }
  });
}

// Moves the range by its own length, or by `by` days when given - so a single
// day steps a day, and a week steps a week.
function step(dir, by = null) {
  closeClock();
  const len = state.end - state.start + 1;
  const shift = (by || len) * dir;
  const latest = manifest.latest_day;
  let a = state.start + shift, b = state.end + shift;
  if (a < 0) [a, b] = [0, len - 1];
  if (b > latest) [a, b] = [Math.max(0, latest - len + 1), latest];
  if (a === state.start && b === state.end) return;
  [state.start, state.end] = [a, b];
  state.preset = null;
  update();
}

function syncDateControls() {
  const ds = $("date-start"), de = $("date-end");
  ds.min = de.min = iso(0);
  ds.max = de.max = iso(manifest.latest_day);
  ds.value = iso(state.start);
  de.value = iso(state.end);
  const len = state.end - state.start + 1;
  $("range-label").textContent =
    `${fmtRange(state.start, state.end)} · ${nf.format(len)} day${len === 1 ? "" : "s"}`;
  $("step-back").disabled = state.start === 0;
  $("step-fwd").disabled = state.end === manifest.latest_day;
}

function syncControls() {
  syncDateControls();
  const running = state.playing;
  $("play").setAttribute("aria-pressed", String(running));
  $("play").querySelector(".play-glyph").textContent = running ? "\u275A\u275A" : "\u25B6";
  $("play").querySelector(".play-text").textContent = running ? "Pause" : "Play";
  $("clock-row").hidden = state.clock == null;
  if (state.clock != null) {
    $("clock-label").textContent = playClock();
    const step = { 1: "a minute", 5: "5 minutes", 15: "15 minutes", 60: "an hour" }[stepMinutes()];
    $("clock-back").title = `Back ${step}`;
    $("clock-fwd").title = `Forward ${step}`;
    $("clock-back").disabled = state.clock <= play.startMinute;
    $("clock-fwd").disabled = state.clock >= play.endMinute;
  }
  for (const b of $("presets").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.preset === state.preset));
  const ys = $("year-select");
  if (ys) ys.value = /^y\d{4}$/.test(state.preset || "") ? state.preset : "";
  for (const b of $("view-seg").children) b.setAttribute("aria-checked", String(b.dataset.view === state.view));
  for (const b of $("color-seg").children) {
    b.setAttribute("aria-checked", String(b.dataset.color === state.colorBy));
    b.disabled = state.view !== "points";
  }
  for (const b of $("zoom-seg").children) b.setAttribute("aria-checked", String(b.dataset.zoom === state.zoom));
  $("min-frp").value = String(state.minFrp);
  $("show-warnings").checked = state.showWarnings;
  $("show-weas").checked = state.showWeas;
  syncBasemapButtons();
}

// Play -------------------------------------------------------------------------
// The clock can be run by the timer or stepped by hand, a step to a click. It
// starts at the first detection in the period rather than at midnight, because
// a fire day usually begins in the afternoon and nobody wants to sit through
// the empty hours.
let playTimer = null;
const play = { loaded: [], startMinute: 0, endMinute: 0, shown: 0 };

// The UTC instant of midnight in Oklahoma on day d. Central Time is five or six
// hours behind UTC depending on daylight saving, so test both.
function localMidnightMinute(d) {
  const base = epochMs + d * DAY_MS;
  const localHour = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" });
  for (const h of [5, 6]) {
    const ms = base + h * 3600000;
    const hour = localHour.formatToParts(ms).find((p) => p.type === "hour").value;
    if (Number(hour) === 0) return ms / 60000;
  }
  return base / 60000 + 360;
}

function playClock() {
  const clock = fmtLocal(state.clock * 60000, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  return `${clock} · ${nf.format(play.shown)} in the last 12 hours`;
}

const stepMinutes = () => Number($("play-step").value);

// The first detection the current filters keep, or null when the period has
// none. `current` is already the selection for these dates and filters.
function firstDetectionMinute() {
  let first = null;
  for (let j = 0; j < current.total; j++) {
    const m = current.loaded[current.rowK[j]].minute[current.rowI[j]];
    if (first === null || m < first) first = m;
  }
  return first;
}

// Loads the period's chunks and settles where the clock starts. Returns false
// when the data could not be loaded.
async function openClock() {
  if (state.clock != null) return true;
  $("busy-text").textContent = "the period";
  $("busy").hidden = false;
  try {
    play.loaded = await Promise.all(chunksFor(state.start, state.end).map(loadChunk));
  } catch (e) {
    $("busy").hidden = true;
    toast("Could not load detections: " + e.message, 8000);
    return false;
  }
  $("busy").hidden = true;
  play.startMinute = localMidnightMinute(state.start);
  play.endMinute = localMidnightMinute(state.end + 1) - 1;
  state.clock = firstDetectionMinute() ?? play.startMinute;
  popup.remove();
  clearHover();
  setVisibility();
  return true;
}

function closeClock() {
  pausePlay();
  state.clock = null;
  play.loaded = [];
  update();
}

// One step of the clock, a click at a time. Stepping past either end of the
// period stops there rather than wrapping into dates the reader did not choose.
async function stepClock(dir) {
  pausePlay();
  if (!(await openClock())) return;
  const next = state.clock + dir * stepMinutes();
  state.clock = Math.max(play.startMinute, Math.min(play.endMinute, next));
  drawClock();
}

async function jumpToFirstDetection() {
  pausePlay();
  if (!(await openClock())) return;
  const first = firstDetectionMinute();
  if (first === null) {
    toast("No detections in this period");
    return;
  }
  state.clock = first;
  drawClock();
}

function drawClock() {
  renderPlayFrame();
  syncControls();
  drawTimeline();
}

async function startPlay() {
  if (!(await openClock())) return;
  // Play again after the clock has run out starts the period over.
  if (state.clock >= play.endMinute) {
    state.clock = firstDetectionMinute() ?? play.startMinute;
  }
  state.playing = true;
  syncControls();
  legendPlayNote();
  frame();
}

function frame() {
  if (!state.playing) return;
  drawClock();
  playTimer = setTimeout(() => {
    if (!state.playing) return;
    if (state.clock >= play.endMinute) { pausePlay(); syncControls(); return; }
    state.clock = Math.min(play.endMinute, state.clock + stepMinutes());
    frame();
  }, PLAY_FRAME_MS);
}

// Pauses on the frame showing, so a reader can stop on the minute a fire
// started and step through it.
function pausePlay() {
  if (!state.playing) return;
  state.playing = false;
  clearTimeout(playTimer);
  syncControls();
}

function legendPlayNote() {
  if ($("legend").querySelector(".warn")) return;
  const note = document.createElement("div");
  note.className = "warn";
  note.textContent = "Each frame shows detections from the 12 hours before the clock, older ones fading. A detection that fades out does not mean the fire went out, only that no satellite has seen it since.";
  $("legend").prepend(note);
}

// Chunks are sorted by time, so the trailing window is a binary search on the
// minute column rather than a scan of the whole period.
function renderPlayFrame() {
  const t = state.clock;
  const from = t - PLAY_TRAIL_MIN + 1;
  const famOn = famIds.map((f) => state.families.has(f));
  const features = [];
  for (const c of play.loaded) {
    for (let i = lowerBound(c.minute, c.n, from); i < c.n && c.minute[i] <= t; i++) {
      if (c.day[i] < state.start || c.day[i] > state.end) continue;
      const f = c.frp[i];
      if (!passesFrp(f) || !famOn[srcFamily[c.src[i]]]) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [c.lon[i], c.lat[i]] },
        properties: { c: frpClass(f), g: srcGroup[c.src[i]], a: (t - c.minute[i]) / PLAY_TRAIL_MIN },
      });
    }
  }
  play.shown = features.length;
  if (styleReady) map.getSource("okf-points").setData({ type: "FeatureCollection", features });
  applyWarningFilter();
}

// Panel ------------------------------------------------------------------------
function tile(parent, value, key, sub, onClick) {
  const t = document.createElement("div");
  t.className = "tile";
  const v = document.createElement(onClick ? "button" : "div");
  v.className = "v";
  v.textContent = value;
  if (onClick) { v.type = "button"; v.addEventListener("click", onClick); }
  t.appendChild(v);
  line(t, "k", key);
  if (sub) line(t, "s", sub);
  parent.appendChild(t);
}

function renderTiles() {
  const sel = current;
  const box = $("tiles");
  box.textContent = "";
  const days = sel.b - sel.a + 1;
  let active = 0, peak = -1, peakN = 0;
  for (let k = 0; k < days; k++) {
    if (sel.byDay[k] > 0) active++;
    if (sel.byDay[k] > peakN) { peakN = sel.byDay[k]; peak = sel.a + k; }
  }
  const nCounties = sel.byCounty.reduce((s, v, i) => s + (i > 0 && v > 0 ? 1 : 0), 0);

  tile(box, nf.format(sel.total), "Detections", `in ${nCounties} of ${manifest.counties.length} counties`);
  tile(box, `${nf.format(active)}`, "Days with detections", `of ${nf.format(days)} day${days === 1 ? "" : "s"}`);
  if (peak >= 0 && days > 1) {
    tile(box, fmtDay(peak, { year: dayDate(sel.a).getUTCFullYear() === dayDate(sel.b).getUTCFullYear() ? undefined : "numeric" }),
      "Busiest day", `${nf.format(peakN)} detections · show this day`,
      () => { closeClock(); [state.start, state.end] = [peak, peak]; state.preset = null; update(); });
  } else {
    tile(box, days === 1 ? fmtDay(sel.a, { year: undefined }) : "None", days === 1 ? "Day shown" : "Busiest day", null);
  }
  if (sel.maxAt) {
    const [k, i] = sel.maxAt;
    const d = describe(k, i);
    tile(box, `${nf.format(Math.round(sel.maxFrp))} MW`, "Most intense detection", `${d.county} · show on map`, () => {
      if (state.view !== "points") { state.view = "points"; update().then(() => flyToDetection(k, i)); }
      else flyToDetection(k, i);
    });
  } else {
    tile(box, "Not measured", "Most intense detection", null);
  }
  tile(box, nf.format(warningsIn(sel.a, sel.b).length), "NWS fire warnings", "in force in this period", null);
  tile(box, nf.format(weasIn(sel.a, sel.b).length), "Wildfire WEAs", "sent to phones in this period", null);

  const notes = [];
  if (sel.b === manifest.latest_day && Date.now() - Date.parse(manifest.data_through) < 36 * 3600000) notes.push("The latest day is still coming in: NOAA adds detections through the day.");
  let missing = 0;
  for (const d of unavailableDays) if (d >= sel.a && d <= sel.b) missing++;
  if (missing) notes.push(`NOAA published no file for ${missing} day${missing === 1 ? "" : "s"} in this period, so those days are gaps, not days without fire.`);
  let cut = 0;
  for (const d of truncatedDays) if (d >= sel.a && d <= sel.b) cut++;
  if (cut) notes.push(`NOAA's file for ${cut === 1 ? "one day" : cut + " days"} in this period ends partway through, so ${cut === 1 ? "that day is" : "those days are"} missing some detections.`);
  $("summary-note").textContent = notes.filter(Boolean).join(" ");
}

function flyToDetection(k, i) {
  // Rows keep their place in `current` only until the next update, so look the
  // detection up again by chunk and row.
  const c = current.loaded[k];
  const lngLat = [c.lon[i], c.lat[i]];
  map.flyTo({ center: lngLat, zoom: Math.max(map.getZoom(), 10), speed: 1.6 });
  map.once("moveend", () => {
    let j = -1;
    for (let q = 0; q < current.total; q++) if (current.loaded[current.rowK[q]] === c && current.rowI[q] === i) { j = q; break; }
    if (j >= 0) showDetections([j], lngLat);
  });
}

function renderFamilies() {
  const box = $("families");
  box.textContent = "";
  manifest.families.forEach((f, idx) => {
    const lab = document.createElement("label");
    lab.className = "family";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.families.has(f.family);
    cb.addEventListener("change", () => {
      if (cb.checked) state.families.add(f.family); else state.families.delete(f.family);
      buildCumulative();
      update();
    });
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = f.label;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = nf.format(current.byFamily[idx]);
    const d = document.createElement("span");
    d.className = "d";
    d.textContent = f.description;
    lab.append(cb, name, n, d);
    box.appendChild(lab);
  });
  const only = document.createElement("button");
  only.type = "button";
  only.className = "link-btn";
  const viirsOnly = state.families.size === 1 && state.families.has("viirs");
  only.textContent = viirsOnly ? "Turn all sensors back on" : "VIIRS only, for comparing years";
  only.title = "GOES-16 began five-minute scans over Oklahoma in 2018 and multiplied detection counts. VIIRS detections run through the archive from 2017.";
  only.addEventListener("click", () => {
    state.families = viirsOnly ? new Set(famIds) : new Set(["viirs"]);
    buildCumulative();
    update();
  });
  box.appendChild(only);
}

function renderCounties() {
  const sel = current;
  const list = $("county-list");
  list.textContent = "";
  const rows = manifest.counties
    .map((c) => ({ c, n: sel.byCounty[c.id] }))
    .sort((x, y) => y.n - x.n || x.c.name.localeCompare(y.c.name));
  const shown = showAllCounties ? rows : rows.filter((r) => r.n > 0).slice(0, 10);
  if (!shown.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No detections in this period.";
    list.appendChild(li);
  }
  const max = rows[0].n || 1;
  for (const r of shown) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.title = `Zoom to ${r.c.name} County`;
    const name = document.createElement("span");
    name.textContent = r.c.name;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = nf.format(r.n);
    const bar = document.createElement("span");
    bar.className = "bar";
    const fill = document.createElement("span");
    fill.style.width = `${(r.n / max) * 100}%`;
    bar.appendChild(fill);
    b.append(name, n, bar);
    b.addEventListener("click", () => zoomToCounty(r.c.id));
    li.appendChild(b);
    list.appendChild(li);
  }
  $("county-more").textContent = showAllCounties ? "Show top 10" : `Show all ${manifest.counties.length} counties`;
}

function renderWarnings() {
  const list = $("warning-list");
  list.textContent = "";
  const rows = warningsIn(current.a, current.b).sort((x, y) => y.properties.t0 - x.properties.t0);
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No fire warnings in this period.";
    list.appendChild(li);
  }
  for (const f of showAllWarnings ? rows : rows.slice(0, 8)) {
    const w = f.properties;
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = fmtWarnTime(w.t0);
    const where = document.createElement("span");
    where.className = "where";
    where.textContent = `${w.county_names}${w.requested_by ? " · " + w.requested_by : ""}`;
    b.append(when, where);
    b.addEventListener("click", () => {
      if (!state.showWarnings) { state.showWarnings = true; syncControls(); applyWarningFilter(); drawTimeline(); writeHash(); }
      zoomToWarning(f);
    });
    li.appendChild(b);
    list.appendChild(li);
  }
  const more = $("warning-more");
  more.hidden = rows.length <= 8;
  more.textContent = showAllWarnings ? "Show the latest 8" : `Show all ${rows.length}`;
}

function renderWeas() {
  const list = $("wea-list");
  list.textContent = "";
  const rows = weasIn(current.a, current.b).sort((x, y) => y.properties.t0 - x.properties.t0);
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No wildfire WEAs in this period.";
    list.appendChild(li);
  }
  for (const f of showAllWeas ? rows : rows.slice(0, 8)) {
    const w = f.properties;
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = fmtWarnTime(w.t0);
    const what = document.createElement("span");
    what.className = "where";
    what.textContent = w.phone;
    b.append(when, what);
    b.addEventListener("click", () => {
      if (!state.showWeas) { state.showWeas = true; syncControls(); applyWarningFilter(); drawTimeline(); writeHash(); }
      zoomToWarning(f, weaCard);
    });
    li.appendChild(b);
    list.appendChild(li);
  }
  const more = $("wea-more");
  more.hidden = rows.length <= 8;
  more.textContent = showAllWeas ? "Show the latest 8" : `Show all ${rows.length}`;
}

function renderLegend() {
  const box = $("legend");
  box.textContent = "";
  const sel = current;
  if (!sel) return;
  const P = PALETTE[tone()];
  const v = effectiveView();

  if (state.view === "points" && v === "heat") {
    line(box, "warn", `${nf.format(sel.total)} detections are too many to draw one by one, so the map shows their density. Narrow the dates or raise the minimum intensity to see individual detections.`);
  }

  const row = (color, label, n, shape = "dot") => {
    const r = document.createElement("div");
    r.className = "row";
    const sw = document.createElement("span");
    sw.className = shape;
    sw.style.background = color;
    if (shape === "swatch" && color === "transparent") sw.style.boxShadow = "inset 0 0 0 1px var(--control-border)";
    const l = document.createElement("span");
    l.textContent = label;
    r.append(sw, l);
    if (n != null) {
      const c = document.createElement("span");
      c.className = "n";
      c.textContent = nf.format(n);
      r.appendChild(c);
    }
    box.appendChild(r);
  };

  if (v === "points" && state.colorBy === "frp") {
    line(box, "note", "Fire radiative power, in megawatts");
    for (let k = 3; k >= 0; k--) row(P.frp[k], FRP_CLASSES[k].label, sel.byClass[k]);
    row(P.none, "Not measured", sel.byClass[NOT_MEASURED]);
  } else if (v === "points") {
    SENSOR_GROUPS.forEach((g, k) => row(P.sensor[k], g.label, sel.byGroup[k]));
  } else if (v === "heat") {
    line(box, "note", "Density of detections");
    const ramp = document.createElement("div");
    ramp.className = "ramp";
    for (const c of P.frp) {
      const s = document.createElement("span");
      s.style.background = c;
      ramp.appendChild(s);
    }
    box.appendChild(ramp);
    const labs = document.createElement("div");
    labs.className = "ramp-labels";
    labs.append(Object.assign(document.createElement("span"), { textContent: "Fewer" }), Object.assign(document.createElement("span"), { textContent: "More" }));
    box.appendChild(labs);
  } else {
    line(box, "note", "Detections per 100 square miles");
    const br = countyBins.breaks;
    const used = [...new Set([...countyBins.bin.values()].filter((b) => b >= 0))].sort((x, y) => y - x);
    const fmt = (x) => nf1.format(x);
    const labels = [];
    for (let k = 0; k <= br.length; k++) {
      const lo = k === 0 ? 0 : br[k - 1], hi = br[k];
      labels.push(k === 0 ? `Under ${fmt(hi ?? Infinity)}` : hi == null ? `${fmt(lo)} or more` : `${fmt(lo)} to ${fmt(hi)}`);
    }
    if (!br.length) labels[0] = "Any";
    const binIndex = (k) => (br.length >= 4 ? k : Math.round((k * 4) / Math.max(1, br.length)));
    for (let k = br.length; k >= 0; k--) {
      const bin = binIndex(k);
      if (!used.includes(bin)) continue;
      const n = [...countyBins.bin.values()].filter((b) => b === bin).length;
      row(P.choro[bin], labels[k], n, "swatch");
    }
    const zero = [...countyBins.bin.values()].filter((b) => b === -1).length;
    if (zero) row("transparent", "No detections", zero, "swatch");
    line(box, "note", "Counts are counties. Hover a county for its total.");
  }

  if (state.showWarnings) {
    const r = document.createElement("div");
    r.className = "row";
    const sw = document.createElement("span");
    sw.className = "swatch warn-swatch";
    sw.style.borderColor = P.warn;
    const l = document.createElement("span");
    l.textContent = "NWS fire warning area";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = nf.format(warningsIn(sel.a, sel.b).length);
    r.append(sw, l, n);
    box.appendChild(r);
  }
  if (state.showWeas) {
    const r = document.createElement("div");
    r.className = "row";
    const sw = document.createElement("span");
    sw.className = "swatch warn-swatch";
    sw.style.borderColor = P.wea;
    const l = document.createElement("span");
    l.textContent = "Wildfire WEA area";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = nf.format(weasIn(sel.a, sel.b).length);
    r.append(sw, l, n);
    box.appendChild(r);
  }
  if (state.showWarnings || state.showWeas) line(box, "note", "A dashed outline is a whole county, for an alert sent without a polygon.");
}

// Sharing ----------------------------------------------------------------------
function writeHash() {
  if (!manifest) return;
  const p = new URLSearchParams();
  if (state.preset && !/^y/.test(state.preset)) p.set("p", state.preset);
  else if (state.preset) p.set("y", state.preset.slice(1));
  else p.set("d", `${iso(state.start)}_${iso(state.end)}`);
  if (state.view !== "points") p.set("v", state.view);
  if (state.colorBy !== "frp") p.set("c", state.colorBy);
  if (state.basemap !== "dark") p.set("b", state.basemap);
  if (state.minFrp) p.set("m", String(state.minFrp));
  if (state.families.size !== famIds.length) p.set("s", famIds.filter((f) => state.families.has(f)).join("."));
  if (state.zoom !== "year") p.set("t", state.zoom);
  if (!state.showWarnings) p.set("w", "0");
  if (!state.showWeas) p.set("a", "0");
  const c = map.getCenter();
  p.set("map", `${map.getZoom().toFixed(2)}/${c.lat.toFixed(3)}/${c.lng.toFixed(3)}`);
  history.replaceState(null, "", "#" + p.toString());
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has("p")) applyPreset(p.get("p")) || applyPreset("30d");
  else if (p.has("y")) applyPreset("y" + p.get("y")) || applyPreset("30d");
  else if (p.has("d")) {
    const [a, b] = p.get("d").split("_").map(isoToDay);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      [state.start, state.end] = [clampDay(Math.min(a, b)), clampDay(Math.max(a, b))];
      state.preset = null;
    } else applyPreset("30d");
  } else applyPreset("30d");
  if (["points", "heat", "counties"].includes(p.get("v"))) state.view = p.get("v");
  if (p.get("c") === "sensor") state.colorBy = "sensor";
  if (BASEMAPS[p.get("b")]) state.basemap = p.get("b");
  if ([1, 10, 50, 100].includes(Number(p.get("m")))) state.minFrp = Number(p.get("m"));
  if (p.has("s")) {
    const s = p.get("s").split(".").filter((f) => famIds.includes(f));
    if (s.length) state.families = new Set(s);
  }
  if (["all", "year", "fit"].includes(p.get("t"))) state.zoom = p.get("t");
  if (p.get("w") === "0") state.showWarnings = false;
  if (p.get("a") === "0") state.showWeas = false;
  const m = (p.get("map") || "").split("/").map(Number);
  if (m.length === 3 && m.every(Number.isFinite)) map.jumpTo({ zoom: m[0], center: [m[2], m[1]] });
}

function savePng() {
  map.once("render", () => {
    const src = map.getCanvas();
    const dpr = src.width / src.clientWidth;
    const head = Math.round(64 * dpr), foot = Math.round(26 * dpr);
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height + head + foot;
    const ctx = out.getContext("2d");
    const dark = tone() === "dark";
    ctx.fillStyle = dark ? "#0e0e0e" : "#fafaf8";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, head);
    const ink = dark ? "#f4f3ef" : "#1c1b19", sub = dark ? "#c3c2b7" : "#52514e";
    const [a, b] = activeRange();
    ctx.fillStyle = ink;
    ctx.font = `600 ${20 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillText("Oklahoma fire detections", 16 * dpr, 28 * dpr);
    ctx.fillStyle = sub;
    ctx.font = `${13.5 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
    const view = { points: "detections", heat: "density", counties: "detections per 100 sq mi" }[effectiveView()];
    const subtitle = state.clock != null
      ? `${playClock()} · map shows detections in the 12 hours before`
      : `${fmtRange(a, b)} · ${nf.format(current.total)} satellite detections · map shows ${view}`;
    ctx.fillText(subtitle, 16 * dpr, 50 * dpr);
    ctx.font = `${11 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
    const credit = state.basemap === "satellite" ? "Imagery © Esri · Labels © CARTO, OpenStreetMap" : "Base map © CARTO, OpenStreetMap contributors";
    ctx.fillText(`Data: NOAA Hazard Mapping System · IPPRA, University of Oklahoma · ${credit}`, 16 * dpr, out.height - 9 * dpr);
    out.toBlob((blob) => saveBlob(blob, `ok_fire_detections_${iso(a)}_${iso(b)}.png`));
  });
  map.triggerRepaint();
}

function downloadCsv() {
  const sel = current;
  if (!sel || !sel.total) { toast("No detections to download"); return; }
  const head = "date_local,time_local,datetime_utc,latitude,longitude,county,sensor,satellite,method,frp_mw\n";
  const parts = [head];
  const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  let buf = [];
  for (let j = 0; j < sel.total; j++) {
    const c = sel.loaded[sel.rowK[j]], i = sel.rowI[j];
    const s = manifest.sources[c.src[i]];
    const ms = c.minute[i] * 60000;
    const f = c.frp[i];
    buf.push([
      iso(c.day[i]), timeFmt.format(ms), new Date(ms).toISOString().slice(0, 16) + "Z",
      c.lat[i].toFixed(4), c.lon[i].toFixed(4), manifest.counties[c.county[i] - 1].name,
      manifest.families[srcFamily[c.src[i]]].label, s.satellite, s.method, f >= 0 ? f.toFixed(2) : "",
    ].join(","));
    if (buf.length === 5000) { parts.push(buf.join("\n") + "\n"); buf = []; }
  }
  if (buf.length) parts.push(buf.join("\n") + "\n");
  saveBlob(new Blob(parts, { type: "text/csv" }), `ok_fire_detections_${iso(sel.a)}_${iso(sel.b)}.csv`);
}

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

let toastTimer = null;
function toast(msg, ms = 3000) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// Freshness --------------------------------------------------------------------
function renderFreshness() {
  const through = Date.parse(manifest.data_through);
  const ageH = (Date.now() - through) / 3600000;
  const mins = Math.round((Date.now() - lastChecked) / 60000);
  $("freshness-text").textContent =
    `Data through ${fmtLocal(through, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}` +
    ` · checked ${mins < 1 ? "just now" : mins + " min ago"}`;
  $("freshness").classList.toggle("stale", ageH > 36);
  $("freshness").title = ageH > 36
    ? "The newest detection is more than a day and a half old. NOAA may be delayed."
    : "This page checks for new detections every 10 minutes.";
}

async function checkForUpdate({ quiet = false } = {}) {
  let m;
  try { m = await fetchManifest(); } catch { return; }
  lastChecked = Date.now();
  if (m.build !== manifest.build) {
    const followLatest = state.preset && !/^y/.test(state.preset);
    const atLatest = state.end === manifest.latest_day;
    const newData = m.total !== manifest.total || m.data_through !== manifest.data_through;
    try {
      warningGeo = await fetchWarnings(m.build);
      weaGeo = await fetchWarnings(m.build, "weas.geojson");
      warningText = null;
      if (styleReady) {
        map.getSource("okf-warnings").setData(warningGeo);
        map.getSource("okf-weas").setData(weaGeo);
      }
    } catch { /* keep the warnings already loaded */ }
    applyManifest(m);
    if (followLatest) applyPreset(state.preset);
    else if (atLatest && state.clock == null) {
      const len = state.end - state.start;
      [state.start, state.end] = [clampDay(m.latest_day - len), m.latest_day];
    }
    renderAbout();
    if (quiet) { renderFreshness(); return; }
    if (state.clock == null) await update();
    if (newData) toast(`New detections loaded - data through ${fmtLocal(Date.parse(m.data_through), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`, 5000);
  }
  renderFreshness();
}

function renderAbout() {
  const m = manifest;
  const box = $("about");
  box.textContent = "";
  const p = (html) => { const e = document.createElement("p"); e.innerHTML = html; box.appendChild(e); };
  const through = fmtLocal(Date.parse(m.data_through), { month: "long", day: "numeric", year: "numeric" });
  p(`Each point is a satellite pixel where NOAA's <a href="https://www.ospo.noaa.gov/Products/land/hms.html">Hazard Mapping System</a> found the heat signature of a fire. Analysts review the automated detections from GOES, VIIRS, MODIS and AVHRR satellites, delete false ones, and add fires the algorithms missed.`);
  p(`A detection is not a fire. One grass fire can be seen by several satellites and by GOES every few minutes, so it can leave dozens of detections. Some detections are industrial heat sources such as gas flares.`);
  p(`<strong>Intensity</strong> is fire radiative power in megawatts. NOAA reports none for analyst-added points, AVHRR, and some GOES detections; those show as "not measured".`);
  p(`<strong>Comparing years.</strong> Counts depend on which satellites were flying. GOES-16 began five-minute scans over Oklahoma in 2018, NOAA-20 joined VIIRS coverage in 2018 and NOAA-21 in 2023, and each raised detection counts without more fire. VIIRS alone, from 2017 on, is the most consistent series, though NOAA-20 and NOAA-21 still add to it.`);
  p(`<strong>Dates</strong> are Oklahoma calendar days in Central Time. NOAA timestamps are UTC, so an evening fire is dated the day it burned, not the next UTC day.`);
  p(`<strong>Coverage.</strong> ${nf.format(m.total)} detections inside Oklahoma from ${fmtDay(0, { month: "long" })} through ${through}.` +
    (m.unavailable_days.length ? ` NOAA published no file for ${m.unavailable_days.length} day${m.unavailable_days.length === 1 ? "" : "s"}; they are marked beneath the timeline.` : "") +
    ((m.truncated_days || []).length ? ` NOAA's file for ${m.truncated_days.length} day${m.truncated_days.length === 1 ? "" : "s"} (${m.truncated_days.join(", ")}) ends partway through a record, so ${m.truncated_days.length === 1 ? "it is" : "they are"} incomplete.` : ""));
  p(`<strong>Fire warnings</strong> are the National Weather Service's Fire Warnings for Oklahoma, issued at the request of local officials or Oklahoma Forestry Services when a wildfire threatens people and evacuations are needed. The violet outline is the warning's own polygon; a dashed outline marks an older warning issued for whole counties without one. ${nf.format(warningGeo.features.length)} warnings since ${fmtDay(0, { month: "long" })}, from the <a href="https://mesonet.agron.iastate.edu/wx/afos/list.phtml">Iowa Environmental Mesonet</a> archive.`);
  p(`<strong>Wildfire WEAs</strong> are the Wireless Emergency Alerts sent to phones in Oklahoma about a wildfire, from any sender, taken from FEMA's <a href="https://www.fema.gov/openfema-data-page/ipaws-archived-alerts">IPAWS archive</a>. An alert counts when its event is Fire Warning or its phone text says wildfire; the few that mention fire otherwise were read by hand. In Oklahoma these come from state and local emergency management, not the National Weather Service, so they do not match the NWS warnings one for one. The aqua outline is the area the sender drew. An alert shows until it expired, or until it was cancelled. The archive records what was sent, not which phones received it. ${nf.format(weaGeo.features.length)} wildfire WEAs since ${fmtDay(0, { month: "long" })}.`);
  p(`<strong>Updates.</strong> The data are refreshed from NOAA automatically, and this page checks for new detections every 10 minutes while it is open.`);
  p(`Built by the <a href="https://ippra.net">Institute for Public Policy Research and Analysis</a> at the University of Oklahoma.`);
}

// Boot -------------------------------------------------------------------------
async function boot() {
  readColors();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readColors(); drawTimeline(); });

  const [m, counties, warnings, weas] = await Promise.all([
    fetchManifest(),
    fetch("data/counties.geojson").then((r) => {
      if (!r.ok) throw new Error(`counties.geojson: HTTP ${r.status}`);
      return r.json();
    }),
    fetchWarnings(window.OKF_BUILD),
    fetchWarnings(window.OKF_BUILD, "weas.geojson"),
  ]);
  countyGeo = counties;
  warningGeo = warnings;
  weaGeo = weas;
  applyManifest(m);
  buildControls();
  readHash();
  buildCumulative();
  renderAbout();
  renderFreshness();

  const initialBasemap = state.basemap;
  state.basemap = "dark";
  if (initialBasemap !== "dark") setBasemap(initialBasemap);
  else if (firstStyleLoaded) addOverlays();

  new ResizeObserver(() => drawTimeline()).observe(tl.canvas);
  await update();
  $("boot").hidden = true;

  setInterval(checkForUpdate, REFRESH_MS);
  setInterval(renderFreshness, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastChecked > REFRESH_MS) checkForUpdate();
  });
}

boot().catch((e) => {
  const l = $("boot");
  l.hidden = false;
  l.classList.add("boot-failed");
  l.textContent = "The map failed to start.\n\n" + (e && e.message ? e.message : String(e));
  console.error(e);
});
