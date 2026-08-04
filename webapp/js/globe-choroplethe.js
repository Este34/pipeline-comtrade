// Choroplèthe sur globe : la même grandeur que la carte Leaflet, posée sur une
// sphère plutôt que sur un plan.
//
// AVIS, ÉCRIT ICI PARCE QU'IL COMPTE POUR QUI REPRENDRA CE CODE : une
// choroplèthe sert à comparer des pays ENTRE EUX, et un globe en cache la
// moitié en permanence. Leaflet fait mieux sur ce terrain — zoom, tuiles,
// infobulles, animation, clic — et reste donc la vue par défaut de l'onglet.
// Le globe y est une seconde lecture, pas un remplacement. Sur les arcs de flux
// le rapport s'inverse : un flux Chili → Chine y est un arc court là où le plan
// le fait traverser trois fois le dessin (voir globe.js).
//
// La technique tient en une idée : les pays ne sont pas des maillages, mais des
// PIXELS. Un canevas équirectangulaire est peint une fois par année et posé en
// texture sur la sphère ; changer d'année repeint le canevas, sans reconstruire
// la moindre géométrie. Un second canevas, jamais affiché, reçoit une couleur
// unique par pays : lire un pixel y donne l'ISO3 sous le curseur.
import { jeton, onThemeChange, rampeSequentielle } from "./theme.js";
import { esc } from "./format.js";

const RAYON = 1;
const CHAMP = 38;
const DISTANCE = 3.1;

/** Définition des textures, en projection équirectangulaire. */
const TEX_L = 2048;
const TEX_H = 1024;

/** Tangage maximal, en radians (~75°). */
const TANGAGE_MAX = 1.309;
const SENSIBILITE = 0.006;

const vivants = new Set();

/** Détruit les globes choroplèthes dont le conteneur a quitté le document. */
export function purgerChoroplethes({ toutes = false } = {}) {
  for (const g of [...vivants]) {
    if (toutes || !g.hote.isConnected) g.detruire();
  }
}

const isoDe = (f) => f.id || f.properties?.ISO_A3 || f.properties?.iso_a3;

/**
 * Peint les pays dans un contexte 2D, avec une couleur par pays.
 *
 * Un tracé PAR PAYS : réunis dans un même chemin, la règle « evenodd »
 * annulerait les recouvrements entre voisins — le même piège que dans bulles.js
 * et globe.js.
 */
function peindre(ctx, geojson, couleurDe, fond) {
  ctx.fillStyle = fond;
  ctx.fillRect(0, 0, TEX_L, TEX_H);
  for (const f of geojson.features || []) {
    const iso = isoDe(f);
    const couleur = couleurDe(iso);
    if (!couleur) continue;
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    if (!Array.isArray(polys)) continue;
    ctx.beginPath();
    for (const poly of polys) {
      for (const anneau of poly) {
        let lonPrec = null;
        anneau.forEach(([lon, lat], i) => {
          // Antiméridien : voir bulles.js. Sans cette coupure, la Russie relie
          // ses deux moitiés par une bande qui barre la planète.
          const saut = lonPrec !== null && Math.abs(lon - lonPrec) > 180;
          lonPrec = lon;
          const x = ((lon + 180) / 360) * TEX_L;
          const y = ((90 - lat) / 180) * TEX_H;
          if (i === 0 || saut) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
    }
    ctx.fillStyle = couleur;
    ctx.fill("evenodd");
  }
}

/**
 * Affiche la choroplèthe sur un globe.
 *
 * @param {HTMLElement} hote conteneur (vidé au préalable)
 * @param {object} geojson fond de carte
 * @param {Map<number, Map<string, number>>} donneesParAnnee
 * @param {{annees:number[], labelFn:(iso:string)=>string, fmt:(v:number)=>string,
 *          onClick?:(iso:string)=>void}} opts
 * @returns {Promise<{detruire:()=>void, setAnnee:(a:number)=>void}|null>}
 *   `null` si WebGL manque : l'appelant doit alors garder Leaflet.
 */
export async function globeChoroplethe(hote, geojson, donneesParAnnee, opts) {
  const { annees, labelFn, fmt, onClick } = opts;

  purgerChoroplethes();
  hote.innerHTML = "";

  const THREE = await import("../vendor/three/three.module.min.js");

  let rendu;
  try {
    rendu = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    return null;
  }
  if (!rendu.getContext()) return null;
  rendu.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  // --- Échelle de couleur, log et GLOBALE sur toutes les années ------------
  // Une échelle recalculée chaque année rendrait les années incomparables, ce
  // que l'animation « Play » ferait passer pour une évolution. Même règle que
  // `interactiveMap`.
  let min = Infinity;
  let max = 0;
  for (const m of donneesParAnnee.values()) {
    for (const v of m.values()) if (v > 0) { min = Math.min(min, v); max = Math.max(max, v); }
  }
  if (!Number.isFinite(min)) min = 1;
  const lmin = Math.log10(min);
  const lmax = Math.log10(max) || 1;

  let RAMPE = rampeSequentielle();
  let sansDonnee = jeton("--ramp-0", "#eef1f7");
  let mer = jeton("--surface-2", "#f7f8fd");

  const pas = (v) => {
    if (!v || v <= 0) return -1;
    const t = (Math.log10(v) - lmin) / (lmax - lmin || 1);
    return Math.min(RAMPE.length - 1, Math.max(0, Math.floor(t * RAMPE.length)));
  };

  // --- Textures -------------------------------------------------------------
  const toileCouleur = document.createElement("canvas");
  toileCouleur.width = TEX_L;
  toileCouleur.height = TEX_H;
  const ctxCouleur = toileCouleur.getContext("2d");

  /*
   * Canevas d'INDEX : une couleur unique par pays, jamais affichée.
   *
   * C'est la désignation par couleur, la manière habituelle de retrouver un
   * objet sous le curseur sans lancer de rayon ni tester 180 polygones. Le
   * numéro du pays est écrit sur les canaux rouge et vert, ce qui laisse de
   * quoi en distinguer 65 536 ; le bleu reste à zéro et marque la mer.
   */
  const toileIndex = document.createElement("canvas");
  toileIndex.width = TEX_L;
  toileIndex.height = TEX_H;
  const ctxIndex = toileIndex.getContext("2d", { willReadFrequently: true });
  const isoParIndex = new Map();
  {
    let n = 0;
    peindre(ctxIndex, geojson, (iso) => {
      if (!iso) return null;
      n += 1;
      isoParIndex.set(n, iso);
      return `rgb(${n & 255}, ${(n >> 8) & 255}, 255)`;
    }, "rgb(0,0,0)");
  }
  const pixelsIndex = ctxIndex.getImageData(0, 0, TEX_L, TEX_H).data;

  let annee = annees[annees.length - 1];
  const valeursDe = (a) => donneesParAnnee.get(a) || new Map();

  function repeindre() {
    peindre(ctxCouleur, geojson, (iso) => {
      const b = pas(valeursDe(annee).get(iso) || 0);
      return b >= 0 ? RAMPE[b] : sansDonnee;
    }, mer);
    texture.needsUpdate = true;
    invalider();
  }

  const texture = new THREE.CanvasTexture(toileCouleur);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = rendu.capabilities.getMaxAnisotropy?.() ?? 1;

  // --- Scène ---------------------------------------------------------------
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CHAMP, 1, 0.1, 100);
  camera.position.set(0, 0, DISTANCE);

  const pivot = new THREE.Group();
  const sphere = new THREE.Group();
  pivot.add(sphere);
  scene.add(pivot);

  /*
   * L'origine des UV d'une SphereGeometry tombe sur le méridien 180 ; la
   * texture, elle, commence à −180. Sans ce quart de tour, l'Amérique se
   * retrouve à la place de l'Asie — et rien ne le signale, la sphère étant
   * parfaitement peinte, seulement décalée.
   */
  const geoSphere = new THREE.SphereGeometry(RAYON, 96, 64);
  const matSphere = new THREE.MeshBasicMaterial({ map: texture });
  const maille = new THREE.Mesh(geoSphere, matSphere);
  maille.rotation.y = -Math.PI / 2;
  sphere.add(maille);

  const geoAtmo = new THREE.SphereGeometry(1.13, 48, 48);
  const matAtmo = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    uniforms: { uCouleur: { value: new THREE.Color(jeton("--viz-1", "#2a78d6")) } },
    vertexShader: `
      varying vec3 vNormale;
      void main() {
        vNormale = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uCouleur;
      varying vec3 vNormale;
      void main() {
        float f = pow(1.0 - abs(dot(vNormale, vec3(0.0, 0.0, 1.0))), 3.5);
        gl_FragColor = vec4(uCouleur, clamp(f, 0.0, 1.0) * 0.35);
      }
    `,
  });
  pivot.add(new THREE.Mesh(geoAtmo, matAtmo));

  // --- DOM ------------------------------------------------------------------
  const boite = document.createElement("div");
  boite.className = "globe-box";
  const scene2d = document.createElement("div");
  scene2d.className = "globe-scene";
  boite.appendChild(scene2d);
  scene2d.appendChild(rendu.domElement);
  rendu.domElement.className = "globe-toile";
  rendu.domElement.setAttribute("role", "img");
  rendu.domElement.setAttribute("tabindex", "0");
  rendu.domElement.setAttribute("aria-label",
    "Globe des échanges par pays. Le tableau équivalent suit le graphique.");

  const infobulle = document.createElement("div");
  infobulle.className = "globe-infobulle";
  infobulle.setAttribute("aria-hidden", "true");
  scene2d.appendChild(infobulle);

  const barre = document.createElement("div");
  barre.className = "map-controls";
  barre.innerHTML = `
    <button class="btn map-play" type="button">▶ Play</button>
    <input type="range" class="map-slider" min="${annees[0]}" max="${annees[annees.length - 1]}"
           value="${annee}" step="1" aria-label="Année">
    <span class="map-year">${annee}</span>`;

  const legende = document.createElement("div");
  legende.className = "map-legend";
  const majLegende = () => {
    legende.innerHTML = `<span>${esc(fmt(min))}</span>`
      + RAMPE.map((c) => `<i style="background:${c}"></i>`).join("")
      + `<span>${esc(fmt(max))}</span>`;
  };
  majLegende();

  hote.append(barre, boite, legende);

  // --- Boucle ---------------------------------------------------------------
  let lacet = 0;
  let tangage = 0.3;
  let cote = 1;
  let vivant = true;
  let demande = 0;

  const borner = (v) => Math.max(-TANGAGE_MAX, Math.min(TANGAGE_MAX, v));

  // Rendu à la demande : une choroplèthe ne bouge pas toute seule. La boucle
  // continue n'a pas lieu d'être — elle brûlerait une image sur soixante pour
  // redessiner exactement la même chose.
  function dessiner() {
    sphere.rotation.y = lacet;
    pivot.rotation.x = tangage;
    rendu.render(scene, camera);
  }
  function invalider() {
    if (!vivant || demande) return;
    demande = requestAnimationFrame(() => { demande = 0; dessiner(); });
  }

  function redimensionner() {
    const r = boite.getBoundingClientRect();
    cote = Math.max(1, Math.min(r.width, r.height));
    rendu.setSize(cote, cote, false);
    rendu.domElement.style.width = `${cote}px`;
    rendu.domElement.style.height = `${cote}px`;
    scene2d.style.width = `${cote}px`;
    scene2d.style.height = `${cote}px`;
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    invalider();
  }

  /**
   * Pays sous le curseur.
   *
   * On inverse la projection à la main : le rayon qui part de la caméra vers le
   * pixel visé est intersecté avec la sphère, le point obtenu est ramené dans
   * le repère du globe, puis converti en latitude/longitude — donc en pixel du
   * canevas d'index. Aucun lancer de rayon de three, et surtout aucun test
   * contre 180 polygones.
   */
  function paysSous(x, y) {
    const ndcX = (x / cote) * 2 - 1;
    const ndcY = -((y / cote) * 2 - 1);
    const tan = Math.tan((CHAMP / 2) * (Math.PI / 180));
    const dir = new THREE.Vector3(ndcX * tan, ndcY * tan, -1).normalize();
    const origine = camera.position.clone();
    // Intersection rayon / sphère unité centrée à l'origine.
    const b = 2 * origine.dot(dir);
    const c = origine.lengthSq() - RAYON * RAYON;
    const delta = b * b - 4 * c;
    if (delta < 0) return null;
    const t = (-b - Math.sqrt(delta)) / 2;
    if (t < 0) return null;
    const p = origine.add(dir.multiplyScalar(t));
    // Retour dans le repère du globe : l'inverse des deux rotations.
    p.applyAxisAngle(new THREE.Vector3(1, 0, 0), -tangage);
    p.applyAxisAngle(new THREE.Vector3(0, 1, 0), -lacet);
    p.normalize();
    const lat = (Math.asin(p.y) * 180) / Math.PI;
    const lon = (Math.atan2(p.x, p.z) * 180) / Math.PI;
    const px = Math.min(TEX_L - 1, Math.max(0, Math.floor(((lon + 180) / 360) * TEX_L)));
    const py = Math.min(TEX_H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * TEX_H)));
    const i = (py * TEX_L + px) * 4;
    if (pixelsIndex[i + 2] < 128) return null; // mer
    return isoParIndex.get(pixelsIndex[i] + (pixelsIndex[i + 1] << 8)) || null;
  }

  // --- Interaction ----------------------------------------------------------
  let saisi = false;
  let dernierX = 0;
  let dernierY = 0;

  const cible = rendu.domElement;
  cible.addEventListener("pointerdown", (e) => {
    saisi = true;
    dernierX = e.clientX;
    dernierY = e.clientY;
    cible.setPointerCapture(e.pointerId);
    boite.classList.add("saisi");
    infobulle.classList.remove("visible");
  });
  cible.addEventListener("pointermove", (e) => {
    if (saisi) {
      lacet += (e.clientX - dernierX) * SENSIBILITE;
      tangage = borner(tangage + (e.clientY - dernierY) * SENSIBILITE);
      dernierX = e.clientX;
      dernierY = e.clientY;
      invalider();
      return;
    }
    const iso = paysSous(e.offsetX, e.offsetY);
    boite.classList.toggle("designe", Boolean(iso));
    if (!iso) { infobulle.classList.remove("visible"); return; }
    const v = valeursDe(annee).get(iso) || 0;
    infobulle.innerHTML = `<b>${esc(labelFn ? labelFn(iso) : iso)}</b><br>${v > 0 ? esc(fmt(v)) : "n.d."}`;
    infobulle.style.transform = `translate(${e.offsetX.toFixed(0)}px,${e.offsetY.toFixed(0)}px)`;
    infobulle.classList.add("visible");
  });
  const lacher = (e) => {
    if (!saisi) return;
    saisi = false;
    if (cible.hasPointerCapture(e.pointerId)) cible.releasePointerCapture(e.pointerId);
    boite.classList.remove("saisi");
  };
  cible.addEventListener("pointerup", lacher);
  cible.addEventListener("pointercancel", lacher);
  cible.addEventListener("pointerleave", () => infobulle.classList.remove("visible"));
  cible.addEventListener("click", (e) => {
    if (!onClick) return;
    const iso = paysSous(e.offsetX, e.offsetY);
    if (iso) onClick(iso);
  });
  cible.addEventListener("keydown", (e) => {
    const PAS = 0.12;
    const gestes = {
      ArrowLeft: () => { lacet -= PAS; },
      ArrowRight: () => { lacet += PAS; },
      ArrowUp: () => { tangage = borner(tangage - PAS); },
      ArrowDown: () => { tangage = borner(tangage + PAS); },
    };
    if (!gestes[e.key]) return;
    e.preventDefault();
    gestes[e.key]();
    invalider();
  });

  // --- Curseur d'année et animation ----------------------------------------
  const glissiere = barre.querySelector(".map-slider");
  const bouton = barre.querySelector(".map-play");
  const etiquetteAnnee = barre.querySelector(".map-year");
  let minuteur = null;

  function setAnnee(a) {
    annee = a;
    etiquetteAnnee.textContent = String(a);
    glissiere.value = String(a);
    repeindre();
  }
  glissiere.addEventListener("input", () => setAnnee(Number(glissiere.value)));

  const arreter = () => {
    if (minuteur) clearInterval(minuteur);
    minuteur = null;
    bouton.textContent = "▶ Play";
  };
  bouton.addEventListener("click", () => {
    if (minuteur) { arreter(); return; }
    bouton.textContent = "⏸ Pause";
    if (annee >= annees[annees.length - 1]) setAnnee(annees[0]);
    minuteur = setInterval(() => {
      // Filet de sécurité : si le conteneur a été détaché entre-temps, le
      // minuteur s'arrête de lui-même plutôt que d'animer dans le vide.
      if (!boite.isConnected) { arreter(); return; }
      setAnnee(annee >= annees[annees.length - 1] ? annees[0] : annee + 1);
      if (annee >= annees[annees.length - 1]) arreter();
    }, 750);
  });

  const obsTaille = new ResizeObserver(() => redimensionner());
  obsTaille.observe(boite);

  const desabonner = onThemeChange(() => {
    RAMPE = rampeSequentielle();
    sansDonnee = jeton("--ramp-0", "#eef1f7");
    mer = jeton("--surface-2", "#f7f8fd");
    matAtmo.uniforms.uCouleur.value = new THREE.Color(jeton("--viz-1", "#2a78d6"));
    majLegende();
    repeindre();
  });

  redimensionner();
  repeindre();

  const instance = {
    hote,
    setAnnee,
    detruire() {
      if (!vivant) return;
      vivant = false;
      arreter();
      cancelAnimationFrame(demande);
      obsTaille.disconnect();
      desabonner();
      geoSphere.dispose();
      matSphere.dispose();
      geoAtmo.dispose();
      matAtmo.dispose();
      texture.dispose();
      rendu.dispose();
      rendu.forceContextLoss();
      rendu.domElement.remove();
      vivants.delete(instance);
    },
  };
  vivants.add(instance);
  return instance;
}
