// Carte choroplèthe interactive (Leaflet). Fond de carte tuilé EN LIGNE
// (habillage uniquement) ; sans réseau, les polygones colorés restent affichés.
// Les DONNÉES viennent toujours de DuckDB-WASM/Parquet (100% offline).
// Leaflet est chargé en global (window.L) via vendor/leaflet/leaflet.js.
import { esc } from "./format.js";

const RAMP = ["#e3e3fd", "#b9c0f4", "#8f9de8", "#5f74d6", "#2f4ab8", "#000091"];
const TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_ATTR = "© OpenStreetMap © CARTO";

function isoOf(feature) {
  return feature.id || feature.properties?.ISO_A3 || feature.properties?.iso_a3;
}

// Registre des cartes vivantes.
//
// Vider le conteneur (`host.innerHTML = ""`, ce que fait chaque relance
// d'analyse) détache le DOM mais ne détruit PAS l'instance Leaflet : ses
// écouteurs sur window survivent, ses 180 polygones aussi, et surtout le
// minuteur de l'animation « Play » continue de redessiner une couche détachée
// pour toujours. Quelques analyses suffisaient alors à saturer le navigateur.
const cartesVivantes = new Set();

// Détruit les cartes dont le conteneur n'est plus dans le document (ou toutes).
export function purgerCartes({ toutes = false } = {}) {
  for (const carte of [...cartesVivantes]) {
    if (toutes || !carte.hote.isConnected) carte.detruire();
  }
}

// dataParAnnee : Map<année, Map<iso3, valeur>>.
// opts : { annees:[...], metric, labelFn(iso3), fmt(v), onClick(iso3) }.
export function interactiveMap(host, geojson, dataParAnnee, opts) {
  const { annees, labelFn, fmt, onClick } = opts;
  purgerCartes(); // récupère l'instance abandonnée par un précédent affichage
  host.innerHTML = "";

  // Échelle de couleur log globale (comparable d'une année à l'autre).
  let min = Infinity, max = 0;
  for (const m of dataParAnnee.values())
    for (const v of m.values()) if (v > 0) { min = Math.min(min, v); max = Math.max(max, v); }
  if (!isFinite(min)) min = 1;
  const lmin = Math.log10(min), lmax = Math.log10(max) || 1;
  const bucket = (v) => {
    if (!v || v <= 0) return -1;
    const t = (Math.log10(v) - lmin) / (lmax - lmin || 1);
    return Math.min(RAMP.length - 1, Math.max(0, Math.floor(t * RAMP.length)));
  };

  // Structure DOM : carte + barre de contrôle (année + Play) + légende.
  const mapDiv = document.createElement("div");
  mapDiv.className = "map-box";
  const ctrl = document.createElement("div");
  ctrl.className = "map-controls";
  const anneeMax = annees[annees.length - 1];
  ctrl.innerHTML = `
    <button class="btn map-play" type="button">▶ Play</button>
    <input type="range" class="map-slider" min="${annees[0]}" max="${anneeMax}" value="${anneeMax}" step="1">
    <span class="map-year">${anneeMax}</span>`;
  const legend = document.createElement("div");
  legend.className = "map-legend";
  legend.innerHTML =
    `<span>${fmt(min)}</span>` + RAMP.map((c) => `<i style="background:${c}"></i>`).join("") + `<span>${fmt(max)}</span>`;
  host.append(ctrl, mapDiv, legend);

  const map = L.map(mapDiv, { center: [25, 10], zoom: 2, worldCopyJump: true, attributionControl: true });
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, subdomains: "abcd", maxZoom: 6 }).addTo(map);

  let annee = anneeMax;
  const valeursDe = (y) => dataParAnnee.get(y) || new Map();

  function styleFeature(feature) {
    const v = valeursDe(annee).get(isoOf(feature)) || 0;
    const b = bucket(v);
    return { fillColor: b >= 0 ? RAMP[b] : "#eceef5", fillOpacity: 0.85, color: "#fff", weight: 0.4 };
  }

  const layer = L.geoJSON(geojson, {
    style: styleFeature,
    onEachFeature: (feature, lyr) => {
      lyr.on("mouseover", () => lyr.setStyle({ weight: 1.5, color: "#333" }));
      lyr.on("mouseout", () => layer.resetStyle(lyr));
      if (onClick) lyr.on("click", () => onClick(isoOf(feature)));
    },
  }).addTo(map);

  // L'infobulle est liée une seule fois par pays ; les rafraîchissements ne font
  // qu'en remplacer le contenu, au lieu de recréer 180 objets Leaflet à chaque
  // pas d'animation.
  function majTooltips() {
    layer.eachLayer((lyr) => {
      const iso3 = isoOf(lyr.feature);
      const v = valeursDe(annee).get(iso3) || 0;
      const nom = labelFn ? labelFn(iso3) : iso3;
      const html = `<b>${esc(nom)}</b><br>${v > 0 ? fmt(v) : "n.d."}`;
      if (lyr.getTooltip()) lyr.setTooltipContent(html);
      else lyr.bindTooltip(html, { sticky: true });
    });
  }

  function rafraichir() {
    layer.setStyle(styleFeature);
    majTooltips();
    ctrl.querySelector(".map-year").textContent = annee;
    ctrl.querySelector(".map-slider").value = annee;
  }
  majTooltips();

  const slider = ctrl.querySelector(".map-slider");
  slider.addEventListener("input", () => { annee = Number(slider.value); rafraichir(); });

  // Animation Play : parcourt les années à ~1,3/s.
  const playBtn = ctrl.querySelector(".map-play");
  let timer = null;
  playBtn.addEventListener("click", () => {
    if (timer) { clearInterval(timer); timer = null; playBtn.textContent = "▶ Play"; return; }
    playBtn.textContent = "⏸ Pause";
    if (annee >= anneeMax) annee = annees[0];
    timer = setInterval(() => {
      // Filet de sécurité : si le conteneur a été détaché entre-temps, le
      // minuteur s'arrête de lui-même plutôt que d'animer dans le vide.
      if (!mapDiv.isConnected) { clearInterval(timer); timer = null; return; }
      annee = annee >= anneeMax ? annees[0] : annee + 1;
      rafraichir();
      if (annee >= anneeMax) { clearInterval(timer); timer = null; playBtn.textContent = "▶ Play"; }
    }, 750);
  });

  // Corrige la taille une fois le conteneur visible.
  setTimeout(() => map.invalidateSize(), 60);

  const instance = {
    hote: host,
    detruire() {
      if (timer) { clearInterval(timer); timer = null; }
      map.remove();
      cartesVivantes.delete(instance);
    },
  };
  cartesVivantes.add(instance);

  return { setYear: (y) => { annee = y; rafraichir(); }, detruire: instance.detruire };
}
