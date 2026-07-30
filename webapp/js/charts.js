// Enveloppes Chart.js (barres, courbes, barres empilées, donut).
// Chart.js est chargé globalement (window.Chart) via vendor/chart.umd.min.js.
//
// Aucune couleur n'est écrite en dur ici : tout est lu sur les jetons CSS via
// theme.js. C'est ce qui permet au thème sombre d'exister — un tableau de
// couleurs figé dans ce module resterait clair sur fond sombre.
//
// Chaque graphe enregistre la fonction qui l'a construit. Au changement de
// thème, cette fonction est rejouée : Chart.js ne relit pas les couleurs d'un
// graphe déjà dessiné, et muter ses options une à une serait à la fois plus
// long et plus fragile qu'une reconstruction.
import { jeton, paletteViz, onThemeChange } from "./theme.js";

// Graphes vivants : { hote, chart, construire }.
const _vivants = new Set();

// Habillage commun (encres, grilles, axes), relu à chaque construction.
function chrome() {
  return {
    ink: jeton("--ink", "#161616"),
    muted: jeton("--ink-muted", "#6a6a75"),
    grid: jeton("--grid", "#e6e7ef"),
    baseline: jeton("--baseline", "#c9cbd8"),
    surface: jeton("--surface", "#ffffff"),
  };
}

// Options partagées : grille discrète, infobulle lisible, légende en encre de
// texte (jamais dans la couleur de la série — la pastille porte l'identité).
function optionsBase(fmt, { legende = false, empile = false, horizontal = false, pourcent = false } = {}) {
  const c = chrome();
  const axeValeur = {
    stacked: empile,
    grid: { color: c.grid, drawTicks: false },
    border: { color: c.baseline },
    ticks: { color: c.muted, callback: (v) => (pourcent ? `${v} %` : fmt(v)) },
    ...(pourcent ? { min: 0, max: 100 } : {}),
  };
  const axeCategorie = {
    stacked: empile,
    grid: { display: false },
    border: { color: c.baseline },
    ticks: { color: c.muted, autoSkip: true, maxRotation: 0 },
  };
  return {
    responsive: true,
    maintainAspectRatio: false,
    // Indispensable, et pas seulement cosmétique : `indexAxis` dit à Chart.js
    // lequel des deux axes porte les CATÉGORIES. S'il est omis alors que les
    // échelles sont décrites en horizontal, l'axe des pays reçoit le formateur
    // de valeurs (il affiche « 0 t » pour les indices 0, 1, 2…) et l'axe des
    // valeurs perd le sien (il affiche des kilogrammes bruts).
    indexAxis: horizontal ? "y" : "x",
    animation: { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 400 },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        display: legende,
        position: "bottom",
        labels: { color: c.ink, boxWidth: 12, boxHeight: 12, usePointStyle: true, pointStyle: "rectRounded", padding: 14 },
      },
      tooltip: {
        backgroundColor: c.ink,
        titleColor: c.surface,
        bodyColor: c.surface,
        padding: 10,
        cornerRadius: 6,
        displayColors: true,
      },
    },
    scales: horizontal ? { x: axeValeur, y: axeCategorie } : { x: axeCategorie, y: axeValeur },
  };
}

function _canvas(hote) {
  hote.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "chart-wrap";
  const canvas = document.createElement("canvas");
  wrap.appendChild(canvas);
  hote.appendChild(wrap);
  return canvas;
}

// Construit (ou reconstruit) le graphe d'un hôte et l'enregistre.
function _poser(hote, construire) {
  for (const e of [..._vivants]) {
    if (e.hote === hote) {
      e.chart.destroy();
      _vivants.delete(e);
    }
  }
  const entree = { hote, chart: construire(), construire };
  _vivants.add(entree);
  return entree.chart;
}

onThemeChange(() => {
  for (const e of [..._vivants]) {
    // Un graphe dont le conteneur a été remplacé par une nouvelle analyse n'a
    // plus à être redessiné : on le détruit au passage plutôt que de laisser
    // Chart.js animer un canvas détaché.
    e.chart.destroy();
    if (!e.hote.isConnected) {
      _vivants.delete(e);
      continue;
    }
    e.chart = e.construire();
  }
});

// Barres horizontales : un classement de pays ou de produits.
// Une seule série : pas de légende, le titre de la carte la nomme.
export function barChart(hote, labels, valeurs, titre, fmt = _compact) {
  return _poser(hote, () => {
    const c = chrome();
    const o = optionsBase(fmt, { horizontal: true });
    // Un classement se survole barre par barre, pas par colonne : le mode
    // « index » ferait remonter une valeur voisine sous le curseur.
    o.interaction = { mode: "nearest", intersect: true };
    o.plugins.tooltip.callbacks = { label: (ctx) => fmt(ctx.parsed.x) };
    // Les noms de pays portent l'information : ils restent tous lisibles,
    // en encre de texte, sans saut automatique d'étiquettes.
    o.scales.y.ticks = { color: c.ink, autoSkip: false };
    return new Chart(_canvas(hote), {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: titre || "",
          data: valeurs,
          backgroundColor: jeton("--viz-1", "#2a78d6"),
          // Extrémité arrondie côté valeur seulement : la base reste ancrée
          // à l'axe, ce qui garde la comparaison des longueurs honnête.
          borderRadius: 4,
          borderSkipped: "start",
        }],
      },
      options: o,
    });
  });
}

// Courbes multi-séries : une évolution dans le temps.
export function lineChart(hote, labels, series, fmt = _compact) {
  return _poser(hote, () => {
    const viz = paletteViz();
    const c = chrome();
    return new Chart(_canvas(hote), {
      type: "line",
      data: {
        labels,
        datasets: series.map((s, i) => ({
          label: s.label,
          data: s.data,
          borderColor: s.couleur || viz[i % viz.length],
          backgroundColor: s.couleur || viz[i % viz.length],
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHitRadius: 12,
          // Anneau de surface autour du point survolé : il le détache des
          // courbes qui passent dessous.
          pointHoverBorderColor: c.surface,
          pointHoverBorderWidth: 2,
        })),
      },
      options: (() => {
        const o = optionsBase(fmt, { legende: series.length > 1 });
        o.plugins.tooltip.callbacks = { label: (ctx) => `${ctx.dataset.label} : ${fmt(ctx.parsed.y)}` };
        return o;
      })(),
    });
  });
}

// Barres empilées : la composition d'un total, année par année ou pays par pays
// (répartition par stade, par minéral, par forme).
// series = [{label, data, couleur?}].
export function stackedBarChart(hote, labels, series, fmt = _compact, { horizontal = false } = {}) {
  return _poser(hote, () => _empile(hote, labels, series, fmt, { horizontal, pourcent: false }));
}

// Barres empilées à 100 % : des PARTS, quand la question est « quelle
// proportion » et non « quel volume ». Le total disparaît volontairement de
// l'axe — le mentionner dans l'infobulle reste nécessaire pour ne pas laisser
// croire que deux barres pleines représentent la même quantité.
export function stackedBar100(hote, labels, series, fmt = _compact, { horizontal = true } = {}) {
  const totaux = labels.map((_, i) => series.reduce((s, serie) => s + (serie.data[i] || 0), 0));
  const parts = series.map((serie) => ({
    ...serie,
    data: serie.data.map((v, i) => (totaux[i] ? (100 * (v || 0)) / totaux[i] : 0)),
    brut: serie.data,
  }));
  return _poser(hote, () =>
    _empile(hote, labels, parts, fmt, { horizontal, pourcent: true, totaux })
  );
}

function _empile(hote, labels, series, fmt, { horizontal, pourcent, totaux }) {
  const viz = paletteViz();
  const c = chrome();
  const o = optionsBase(fmt, { legende: series.length > 1, empile: true, horizontal, pourcent });
  o.interaction = { mode: "index", intersect: false };
  o.plugins.tooltip.callbacks = {
    label: (ctx) => {
      const s = series[ctx.datasetIndex];
      const v = pourcent ? s.brut?.[ctx.dataIndex] : ctx.parsed[horizontal ? "x" : "y"];
      const part = pourcent ? ` (${ctx.parsed[horizontal ? "x" : "y"].toFixed(1).replace(".", ",")} %)` : "";
      return `${s.label} : ${fmt(v || 0)}${part}`;
    },
    footer: (items) => {
      if (!items.length) return "";
      const i = items[0].dataIndex;
      const total = totaux ? totaux[i] : series.reduce((s, serie) => s + (serie.data[i] || 0), 0);
      return `Total : ${fmt(total)}`;
    },
  };
  return new Chart(_canvas(hote), {
    type: "bar",
    data: {
      labels,
      datasets: series.map((s, i) => ({
        label: s.label,
        data: s.data,
        backgroundColor: s.couleur || viz[i % viz.length],
        // 2 px de surface entre deux segments : la frontière se voit sans
        // qu'aucune couleur étrangère n'entre dans la pile.
        borderColor: c.surface,
        borderWidth: 2,
        borderRadius: 2,
        borderSkipped: false,
      })),

    },
    options: o,
  });
}

// Donut : répartition simple (conservé pour compatibilité, peu utilisé).
export function donutChart(hote, labels, valeurs) {
  return _poser(hote, () => {
    const viz = paletteViz();
    const c = chrome();
    return new Chart(_canvas(hote), {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data: valeurs,
          backgroundColor: labels.map((_, i) => viz[i % viz.length]),
          borderColor: c.surface,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { color: c.ink, usePointStyle: true, pointStyle: "rectRounded" } },
        },
      },
    });
  });
}

function _compact(v) {
  const n = Math.abs(v);
  if (n >= 1e9) return (v / 1e9).toFixed(0) + " Md";
  if (n >= 1e6) return (v / 1e6).toFixed(0) + " M";
  if (n >= 1e3) return (v / 1e3).toFixed(0) + " k";
  return String(v);
}
