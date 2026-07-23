// Wrappers Chart.js (barres, courbes, donut) + choroplèthe SVG légère.
// Chart.js est chargé globalement (window.Chart) via vendor/chart.umd.min.js.

const PALETTE = [
  "#000091", "#e1000f", "#2f5c96", "#e67e22", "#5cb85c",
  "#8a5a00", "#6a4fbf", "#0aa2c0", "#c0392b", "#4e79a7",
];

const _charts = new WeakMap();

function _mount(canvasHost) {
  const prev = _charts.get(canvasHost);
  if (prev) prev.destroy();
  canvasHost.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "chart-wrap";
  const canvas = document.createElement("canvas");
  wrap.appendChild(canvas);
  canvasHost.appendChild(wrap);
  return canvas;
}

function _register(host, chart) {
  _charts.set(host, chart);
  return chart;
}

// Barres horizontales : labels + valeurs.
export function barChart(host, labels, valeurs, titre) {
  const canvas = _mount(host);
  const chart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{ label: titre || "", data: valeurs, backgroundColor: "#000091" }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { callback: (v) => _compact(v) } } },
    },
  });
  return _register(host, chart);
}

// Courbes multi-séries : {labels, series:[{label, data}]}.
export function lineChart(host, labels, series) {
  const canvas = _mount(host);
  const chart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: series.map((s, i) => ({
        label: s.label,
        data: s.data,
        borderColor: PALETTE[i % PALETTE.length],
        backgroundColor: PALETTE[i % PALETTE.length],
        tension: 0.25,
        pointRadius: 2,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: { y: { ticks: { callback: (v) => _compact(v) } } },
    },
  });
  return _register(host, chart);
}

// Donut : répartition (labels + valeurs).
export function donutChart(host, labels, valeurs) {
  const canvas = _mount(host);
  const chart = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data: valeurs, backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length]) }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right" } } },
  });
  return _register(host, chart);
}

function _compact(v) {
  const n = Math.abs(v);
  if (n >= 1e9) return (v / 1e9).toFixed(0) + " Md";
  if (n >= 1e6) return (v / 1e6).toFixed(0) + " M";
  if (n >= 1e3) return (v / 1e3).toFixed(0) + " k";
  return v;
}

// --- Choroplèthe SVG (projection équirectangulaire, échelle log) ---

const SVG_NS = "http://www.w3.org/2000/svg";
const MAP_W = 1000, MAP_H = 500;

function _proj([lon, lat]) {
  return [((lon + 180) / 360) * MAP_W, ((90 - lat) / 180) * MAP_H];
}

function _pathD(geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let d = "";
  for (const poly of polys) {
    for (const ring of poly) {
      ring.forEach((pt, i) => {
        const [x, y] = _proj(pt);
        d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
      });
      d += "Z";
    }
  }
  return d;
}

// Rampe de bleus (clair -> foncé) sur 6 paliers.
const RAMP = ["#e3e3fd", "#b9c0f4", "#8f9de8", "#5f74d6", "#2f4ab8", "#000091"];

// host: élément conteneur ; valeurs: Map(ISO3 -> nombre) ; labelFn(iso3)->nom.
export function choropleth(host, geojson, valeurs, labelFn) {
  host.innerHTML = "";
  const vals = [...valeurs.values()].filter((v) => v > 0);
  const min = vals.length ? Math.min(...vals) : 1;
  const max = vals.length ? Math.max(...vals) : 1;
  const lmin = Math.log10(min), lmax = Math.log10(max) || 1;
  const bucket = (v) => {
    if (!v || v <= 0) return -1;
    const t = (Math.log10(v) - lmin) / (lmax - lmin || 1);
    return Math.min(RAMP.length - 1, Math.max(0, Math.floor(t * RAMP.length)));
  };

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${MAP_W} ${MAP_H}`);
  svg.setAttribute("class", "choropleth");
  const tip = document.createElementNS(SVG_NS, "title");

  for (const f of geojson.features) {
    const iso3 = f.id || f.properties?.ISO_A3 || f.properties?.iso_a3;
    const v = valeurs.get(iso3) || 0;
    const b = bucket(v);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", _pathD(f.geometry));
    if (b >= 0) path.style.fill = RAMP[b];
    const t = document.createElementNS(SVG_NS, "title");
    const nom = labelFn ? labelFn(iso3) : iso3;
    t.textContent = v > 0 ? `${nom} : ${_compact(v)} $` : nom || "";
    path.appendChild(t);
    svg.appendChild(path);
  }
  host.appendChild(svg);

  // Légende
  const leg = document.createElement("div");
  leg.className = "map-legend";
  leg.innerHTML =
    `<span>${_compact(min)} $</span>` +
    RAMP.map((c) => `<i style="background:${c}"></i>`).join("") +
    `<span>${_compact(max)} $</span>`;
  host.appendChild(leg);
}
