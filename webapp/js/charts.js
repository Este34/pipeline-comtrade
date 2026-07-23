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

// Barres horizontales : labels + valeurs. `fmt` = formateur d'axe optionnel.
export function barChart(host, labels, valeurs, titre, fmt = _compact) {
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
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => fmt(c.parsed.x) } },
      },
      scales: { x: { ticks: { callback: (v) => fmt(v) } } },
    },
  });
  return _register(host, chart);
}

// Courbes multi-séries : {labels, series:[{label, data}]}. `fmt` = formateur d'axe.
export function lineChart(host, labels, series, fmt = _compact) {
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
      plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
      scales: { y: { ticks: { callback: (v) => fmt(v) } } },
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
