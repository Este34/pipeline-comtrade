// Globe des flux : le même graphe que `bulles.js`, posé sur une sphère.
//
// Ce que le globe apporte et que le plan ne peut pas donner : un flux
// Chili → Chine y est un arc court passant par le Pacifique, alors que sur une
// carte plate il traverse trois fois le dessin. Ce que le plan garde pour lui :
// on y voit le monde entier d'un coup. Les deux coexistent donc, et
// `diagramme-flux.js` laisse le lecteur choisir.
//
// LE LANGAGE VISUEL EST CELUI DES RUBANS. Un arc part large de l'origine et
// s'affine vers la destination, son opacité monte à mesure qu'il maigrit, et une
// impulsion le parcourt dans le sens du flux. Basculer d'une représentation à
// l'autre ne demande donc rien à réapprendre.
//
// three.js est chargé DANS la fonction, jamais en tête de module : les onglets
// qui n'affichent pas de globe ne téléchargent aucun de ses 733 Ko. Voir
// `vendor/three/README.md`.
//
// ATTENTION — le contenu des littéraux GLSL ci-dessous est en ASCII pur, SANS
// ACCENT NI BACKTICK. Un backtick dans un commentaire de shader ferme le
// littéral gabarit qui le contient, et l'erreur remonte en « SyntaxError »
// dans du code parfaitement valide quelques lignes plus bas.
import { jeton, onThemeChange } from "./theme.js";
import { tableauFlux } from "./ui.js";
import { esc } from "./format.js";

/** Rayon du globe dans la scène. Toutes les autres tailles s'y rapportent. */
const RAYON = 1;

/**
 * Distance de la caméra.
 *
 * À 3,4 avec un champ de 38°, la demi-hauteur visible au centre de la scène
 * vaut tan(19°) × 3,4 = 1,17 — or l'atmosphère a un rayon de 1,22 et se ferait
 * trancher, ce qui donne une silhouette octogonale. À 4,4 la demi-hauteur passe
 * à 1,51, soit ~24 % de marge. C'est la distance qu'on règle et non le champ :
 * élargir le champ aplatirait la sphère par excès de perspective.
 */
const DISTANCE_CAMERA = 4.4;
const CHAMP = 38;
const RAYON_ATMOSPHERE = 1.22;

/** Semis de points AVANT filtrage par les terres ; ~29 % survivent. */
const NB_POINTS = 22000;

/** Définition du masque des terres, en projection équirectangulaire. */
const MASQUE_L = 2048;
const MASQUE_H = 1024;

/** Rayon des bulles, en unités de la sphère. */
const R_BULLE_MIN = 0.018;
const R_BULLE_MAX = 0.075;

/**
 * Rayon des arcs à l'origine, et part restante à la pointe.
 *
 * Bornes en fraction du rayon des bulles plutôt qu'en absolu : sur un cadre
 * européen les bulles rétrécissent, et des arcs restés à leur taille mondiale
 * les recouvriraient.
 */
const R_ARC_MIN = 0.004;
const R_ARC_MAX = 0.02;
const PART_ARC = 0.6;
const EFFILEMENT = 0.16;

/** Tangage maximal, en radians (~75°) : au-delà on regarde un pôle de face. */
const TANGAGE_MAX = 1.309;

/** Radians par pixel de glissement. */
const SENSIBILITE = 0.006;

/** Constante de temps de l'inertie, en secondes. Courte : c'est un outil. */
const FROTTEMENT = 0.35;

/**
 * Registre des globes vivants, sur le modèle de `purgerCartes()` dans map.js.
 *
 * Vider un conteneur (`hote.innerHTML = ""`, ce que fait chaque relance
 * d'analyse) détache le DOM mais ne libère NI le contexte WebGL, NI les tampons
 * GPU des géométries. Un navigateur n'accorde qu'une poignée de contextes : sans
 * ce registre, quelques analyses suffisent à épuiser le quota, et les globes
 * suivants échouent silencieusement en retombant sur le diagramme.
 */
const globesVivants = new Set();

/** Détruit les globes dont le conteneur a quitté le document (ou tous). */
export function purgerGlobes({ toutes = false } = {}) {
  for (const g of [...globesVivants]) {
    if (toutes || !g.hote.isConnected) g.detruire();
  }
}

/**
 * Masque des terres, rasterisé une fois pour toutes.
 *
 * Tester 22 000 points contre 180 polygones coûterait deux ordres de grandeur
 * de plus. Ici : une passe de remplissage, puis une lecture de pixel par point.
 * Le résultat est mis en cache au niveau du module — le fond de carte ne change
 * jamais, et plusieurs globes peuvent coexister sur une page.
 */
let _masque = null;
function masqueTerres(geojson) {
  if (_masque) return _masque;
  // Le tampon rendu est un octet par pixel (2 Mo) et non le RGBA de
  // `getImageData` (8 Mo) : il est gardé pour toute la session, autant ne pas
  // retenir trois canaux dont on ne fait rien.
  const toile = document.createElement("canvas");
  toile.width = MASQUE_L;
  toile.height = MASQUE_H;
  const ctx = toile.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, MASQUE_L, MASQUE_H);
  ctx.fillStyle = "#fff";

  const anneau = (coords) => {
    let lonPrec = null;
    coords.forEach(([lon, lat], i) => {
      // Voir bulles.js : un anneau qui franchit l'antiméridien relierait sinon
      // ses deux moitiés par une bande qui barre la planète.
      const saut = lonPrec !== null && Math.abs(lon - lonPrec) > 180;
      lonPrec = lon;
      const x = ((lon + 180) / 360) * MASQUE_L;
      const y = ((90 - lat) / 180) * MASQUE_H;
      if (i === 0 || saut) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  };

  // Un remplissage PAR PAYS : réunis dans un même tracé, la règle « evenodd »
  // annulerait les recouvrements entre voisins (voir bulles.js).
  for (const f of geojson.features || []) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    if (!Array.isArray(polys)) continue;
    ctx.beginPath();
    for (const poly of polys) for (const a of poly) anneau(a);
    ctx.fill("evenodd");
  }

  const rgba = ctx.getImageData(0, 0, MASQUE_L, MASQUE_H).data;
  _masque = new Uint8Array(MASQUE_L * MASQUE_H);
  for (let i = 0; i < _masque.length; i++) _masque[i] = rgba[i * 4] > 128 ? 1 : 0;
  return _masque;
}

/**
 * Position cartésienne d'un point géographique, sur une sphère de rayon r.
 *
 * La longitude est portée par (x, z) avec x = sin(λ) et z = cos(λ), et non
 * l'inverse : c'est ce qui met le méridien zéro face à la caméra (+Z) et l'est
 * à DROITE de l'écran, l'orientation de n'importe quel planisphère. Avec la
 * convention symétrique, la Chine se retrouvait à l'ouest de l'Europe — un
 * globe en miroir, ce qui ne se voit pas tout de suite mais fausse toute
 * lecture.
 */
function versVecteur(THREE, lon, lat, r = RAYON) {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  return new THREE.Vector3(
    r * Math.cos(phi) * Math.sin(lambda),
    r * Math.sin(phi),
    r * Math.cos(phi) * Math.cos(lambda),
  );
}

/**
 * Interpolation SPHÉRIQUE entre deux points de la sphère.
 *
 * L'interpolation linéaire suivie d'une normalisation donne bien un point du
 * grand cercle, mais elle dégénère quand les deux extrémités approchent
 * l'antipode : le segment passe alors près du centre de la sphère, et
 * normaliser un vecteur presque nul amplifie l'erreur numérique jusqu'à
 * envoyer l'arc dans une direction arbitraire. C'est ce qui faisait partir les
 * trajets transpacifiques hors du cadre.
 */
function slerp(THREE, a, b, t) {
  const cos = Math.min(1, Math.max(-1, a.dot(b)));
  const omega = Math.acos(cos);
  const sin = Math.sin(omega);
  // Points confondus ou rigoureusement opposés : aucun grand cercle unique ne
  // les relie, l'interpolation linéaire est alors la moins mauvaise réponse.
  if (sin < 1e-6) return a.clone().lerp(b, t).normalize();
  return a.clone().multiplyScalar(Math.sin((1 - t) * omega) / sin)
    .addScaledVector(b, Math.sin(t * omega) / sin)
    .normalize();
}

/**
 * Tube effilé le long d'un grand cercle, construit à la main.
 *
 * `TubeGeometry` de three ne sait faire qu'un rayon constant. Or c'est
 * précisément la décroissance du rayon qui porte le sens du flux : il faut donc
 * poser les anneaux soi-même. On en profite pour écrire un attribut `aT`, la
 * position le long du tube, dont le fragment shader se sert pour le dégradé et
 * l'impulsion.
 *
 * Le repère local de chaque anneau est pris sur la sphère : la « verticale »
 * d'un arc, c'est le rayon terrestre. Aucun transport parallèle à calculer, et
 * le ruban ne vrille jamais.
 */
function tubeEffile(THREE, a, b, rayonDepart, margeDepart = 0, margeArrivee = 0, degagement = 0) {
  const SEGMENTS = 56;
  const COTES = 8;
  const angle = a.angleTo(b);
  /*
   * L'arc démarre au BORD des bulles, pas à leur centre.
   *
   * Sur la sphère unité, la distance parcourue vaut l'angle : une marge
   * exprimée en rayon de bulle s'y convertit directement. Sans ce retrait, un
   * flux entre deux pays voisins — l'Allemagne et la Tchéquie — était plus
   * court que les deux bulles qu'il relie, et disparaissait entièrement sous
   * elles. Le diagramme applique la même règle en unités de dessin.
   *
   * Les marges sont plafonnées à 35 % de la longueur : sur un trajet très
   * court, mieux vaut un arc écrasé qu'un arc inversé.
   */
  const t0 = angle > 1e-4 ? Math.min(0.35, margeDepart / angle) : 0;
  const t1 = angle > 1e-4 ? 1 - Math.min(0.35, margeArrivee / angle) : 1;
  /*
   * La hauteur suit la distance : un arc court qui monterait autant qu'un arc
   * long ferait une bosse absurde au-dessus de deux pays voisins.
   *
   * Elle est PLAFONNÉE, et bas. Un trajet transpacifique atteint π radians :
   * à 0,17 par radian l'arc culminait à 1,59 fois le rayon, au-delà même de la
   * demi-hauteur visible (1,51). Il sortait du cadre, et les trajets longs se
   * lisaient comme des orbites plutôt que comme des échanges. À 0,18 au plus,
   * ils épousent le globe.
   */
  //
  // Elle a aussi un PLANCHER, lié à la taille des bulles reliées. Un flux entre
  // deux pays voisins est court, donc bas : il restait enfoui dans les deux
  // sphères qu'il joignait, et les échanges intra-européens ne se voyaient pas
  // du tout. L'arc doit passer au-dessus des bulles, pas entre elles.
  const hauteur = Math.min(0.24, Math.max(0.03 + angle * 0.06, degagement * 2.4));
  const rFin = Math.max(R_ARC_MIN * 0.6, rayonDepart * EFFILEMENT);

  const positions = [];
  const ts = [];
  const index = [];

  // `u` court sur le tube dessiné (0 à 1), `t` sur le grand cercle complet :
  // le dégradé et l'impulsion restent ainsi calés sur les extrémités visibles.
  const versT = (u) => t0 + (t1 - t0) * u;
  const surArc = (u) => {
    const t = versT(u);
    return slerp(THREE, a, b, t).multiplyScalar(RAYON + hauteur * Math.sin(Math.PI * t));
  };

  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    const centre = surArc(t);
    /*
     * La tangente est prise vers l'AVANT, sauf au dernier anneau où elle est
     * prise vers l'arrière.
     *
     * Écrire `surArc(min(1, t + pas))` paraissait prudent : au dernier anneau,
     * il renvoie le point lui-même, la différence est nulle, et `normalize()`
     * d'un vecteur nul donne des NaN. Trois sommets NaN suffisent à rendre la
     * sphère englobante invalide, et three écarte alors le tube entier au test
     * du champ de vision — l'arc disparaît sans la moindre erreur.
     */
    const avant = i < SEGMENTS ? surArc(t + 1 / SEGMENTS) : centre;
    const arriere = i < SEGMENTS ? centre : surArc(t - 1 / SEGMENTS);
    const tangente = (i < SEGMENTS ? avant.clone().sub(arriere) : centre.clone().sub(arriere)).normalize();
    const radial = centre.clone().normalize();
    const binormal = new THREE.Vector3().crossVectors(tangente, radial).normalize();
    const normal = new THREE.Vector3().crossVectors(binormal, tangente).normalize();
    // Décroissance en puissance 0,75, comme les rubans SVG : linéaire, le tube
    // maigrit trop tôt et l'effilement ne se lit plus qu'au dernier tiers.
    const r = rayonDepart + (rFin - rayonDepart) * Math.pow(t, 0.75);

    for (let j = 0; j < COTES; j++) {
      const a2 = (j / COTES) * Math.PI * 2;
      const dx = Math.cos(a2) * r;
      const dy = Math.sin(a2) * r;
      positions.push(
        centre.x + normal.x * dx + binormal.x * dy,
        centre.y + normal.y * dx + binormal.y * dy,
        centre.z + normal.z * dx + binormal.z * dy,
      );
      ts.push(t);
    }
  }
  for (let i = 0; i < SEGMENTS; i++) {
    for (let j = 0; j < COTES; j++) {
      const a0 = i * COTES + j;
      const a1 = i * COTES + ((j + 1) % COTES);
      const b0 = a0 + COTES;
      const b1 = a1 + COTES;
      index.push(a0, b0, a1, a1, b0, b1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("aT", new THREE.Float32BufferAttribute(ts, 1));
  geo.setIndex(index);
  return geo;
}

/** Vecteur unité d'un couple (lon, lat), sans dépendre de three. */
function unite(lon, lat) {
  const phi = (lat * Math.PI) / 180;
  const lam = (lon * Math.PI) / 180;
  return [Math.cos(phi) * Math.sin(lam), Math.sin(phi), Math.cos(phi) * Math.cos(lam)];
}

/**
 * Distance de caméra ajustée à l'étendue des données.
 *
 * À distance fixe, le globe montre toujours un hémisphère : onze États membres
 * n'y occupaient qu'un dixième du disque et leurs échanges devenaient
 * illisibles. On recule donc juste ce qu'il faut pour que le pays le plus
 * éloigné du centre tombe aux trois quarts du rayon de l'image.
 *
 * La géométrie : un point à l'angle θ du centre de vue se projette à
 * sin(θ)/(D − cos(θ)) en unités de tangente, et le demi-champ vaut tan(19°).
 * D'où D = cos(θ) + sin(θ) / (0,75 × tan(19°)).
 *
 * Le résultat est borné. En deçà de 2,4 la perspective devient si rasante que
 * la sphère ne se lit plus comme telle ; au-delà de 4,4 on s'éloigne sans rien
 * gagner (voir DISTANCE_CAMERA).
 */
function cadrer(noeuds, centre) {
  const c = unite(centre.lon, centre.lat);
  let thetaMax = 0;
  for (const n of noeuds) {
    const p = unite(n.lon, n.lat);
    const cos = Math.min(1, Math.max(-1, p[0] * c[0] + p[1] * c[1] + p[2] * c[2]));
    thetaMax = Math.max(thetaMax, Math.acos(cos));
  }
  // Une marge : sans elle, les bulles du bord touchent le cadre.
  const theta = Math.min(Math.PI / 2.2, thetaMax * 1.25);
  const cible = 0.75 * Math.tan((CHAMP / 2) * (Math.PI / 180));
  const distance = Math.min(
    DISTANCE_CAMERA,
    Math.max(2.4, Math.cos(theta) + Math.sin(theta) / cible),
  );
  return {
    distance,
    /*
     * L'atmosphère n'est montrée que si elle tient dans le champ. À courte
     * distance, la demi-hauteur visible au centre (tan(19°) × D) descend sous
     * son rayon de 1,22 : elle se ferait trancher et rendrait au globe la
     * silhouette octogonale qu'on avait justement corrigée.
     */
    montrerAtmosphere: Math.tan((CHAMP / 2) * (Math.PI / 180)) * distance > RAYON_ATMOSPHERE,
  };
}

/** Barycentre des nœuds pondéré par le volume, en degrés. Voir `centre`. */
function centreAuto(noeuds) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const n of noeuds) {
    const p = (n.valeur > 0 ? Math.sqrt(n.valeur) : 0);
    const phi = (n.lat * Math.PI) / 180;
    const lam = (n.lon * Math.PI) / 180;
    x += p * Math.cos(phi) * Math.sin(lam);
    y += p * Math.sin(phi);
    z += p * Math.cos(phi) * Math.cos(lam);
  }
  const norme = Math.hypot(x, y, z);
  if (!norme) return { lon: 10, lat: 30 };
  return {
    lon: (Math.atan2(x, z) * 180) / Math.PI,
    lat: (Math.asin(y / norme) * 180) / Math.PI,
  };
}

/**
 * Dessine le globe.
 *
 * @param {HTMLElement} hote conteneur (vidé au préalable)
 * @param {{noeuds: Array<{id,label,titre?,valeur,lon,lat,couleur?}>,
 *          liens: Array<{source,target,valeur,couleur?}>}} graphe
 * @param {{fmt:(v:number)=>string, geojson:object, resume?:string,
 *          centre?:{lon:number,lat:number}, onClick?:(id:string)=>void}} opts
 * @returns {Promise<{detruire:()=>void, focus:(id:string)=>void}|null>}
 *   `null` si WebGL n'est pas disponible — l'appelant doit alors se rabattre
 *   sur le diagramme.
 */
export async function globe(hote, { noeuds, liens }, opts) {
  const { fmt, geojson, resume, onClick } = opts;

  const actifs = (noeuds || []).filter((n) => n.valeur > 0 && Number.isFinite(n.lon));
  const utiles = (liens || []).filter((l) => l.valeur > 0);
  if (!actifs.length) {
    hote.innerHTML = `<div class="empty">Aucun échange déclaré pour ces paramètres.</div>`;
    return null;
  }

  /*
   * Orientation d'ouverture.
   *
   * Sans consigne, elle se déduit des données : moyenne des positions pondérée
   * par le volume, calculée sur les VECTEURS et non sur les longitudes — une
   * moyenne d'angles place le barycentre du Pacifique en plein Sahara dès
   * qu'on franchit l'antiméridien.
   *
   * L'appelant garde la main : la section « intra-UE » veut l'Europe de face,
   * qu'il y ait ou non un gros exportateur ailleurs.
   */
  const centre = opts.centre || centreAuto(actifs);

  purgerGlobes();
  hote.innerHTML = "";

  const THREE = await import("../vendor/three/three.module.min.js");

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CHAMP, 1, 0.1, 100);
  const cadrage = cadrer(actifs, centre);
  camera.position.set(0, 0, cadrage.distance);

  let rendu;
  try {
    rendu = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    return null;
  }
  if (!rendu.getContext()) return null;
  rendu.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const boite = document.createElement("div");
  boite.className = "globe-box";
  /*
   * Une scène intermédiaire, exactement à la taille du canevas.
   *
   * Le canevas est carré et centré dans une boîte qui ne l'est pas toujours
   * (`max-height` la rabote sur un écran bas). Les étiquettes, calculées dans le
   * repère du canevas, se retrouvaient alors décalées de tout l'écart de
   * centrage — sur un cadre européen, une colonne de codes ISO3 flottait à
   * deux cents pixels à gauche des bulles. Elles vivent désormais dans un
   * conteneur qui a rigoureusement les dimensions du rendu.
   */
  const scene2d = document.createElement("div");
  scene2d.className = "globe-scene";
  boite.appendChild(scene2d);
  scene2d.appendChild(rendu.domElement);
  rendu.domElement.className = "globe-toile";
  rendu.domElement.setAttribute("role", "img");
  rendu.domElement.setAttribute("tabindex", "0");
  rendu.domElement.setAttribute("aria-label",
    resume || `Globe des échanges : ${actifs.length} pays, ${utiles.length} flux.`);
  hote.appendChild(boite);

  const couche = document.createElement("div");
  couche.className = "globe-etiquettes";
  couche.setAttribute("aria-hidden", "true");
  scene2d.appendChild(couche);

  const infobulle = document.createElement("div");
  infobulle.className = "globe-infobulle";
  infobulle.setAttribute("aria-hidden", "true");
  scene2d.appendChild(infobulle);

  /*
   * Deux groupes emboîtés : le parent porte le tangage, l'enfant le lacet.
   *
   * L'ordre compte. Le lacet est appliqué EN PREMIER, donc autour de l'axe des
   * pôles du globe lui-même ; le tangage bascule ensuite l'ensemble vers
   * l'observateur. Un seul groupe portant les deux ferait précesser l'axe — le
   * globe tournerait autour de la verticale du monde et ses pôles décriraient
   * un cône.
   */
  const pivot = new THREE.Group();
  const sphere = new THREE.Group();
  pivot.add(sphere);
  scene.add(pivot);

  const aJeter = [];
  const matsArcs = [];
  const bulles = [];
  // Matériaux dont les couleurs sont relues au changement de thème. Déclarés
  // ici pour que les blocs qui suivent ne fuient pas de `var`.
  let matPoints;
  let matTraits;
  let matAtmo;
  let matPlein;
  /** Côté du canevas en pixels CSS, tenu à jour par `redimensionner()`. */
  let cote = 1;

  const mouvementReduit = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // --- Couleurs, relues à chaque changement de thème ------------------------
  const palette = () => ({
    terres: new THREE.Color(jeton("--ramp-3", "#6da7ec")),
    halo: new THREE.Color(jeton("--viz-1", "#2a78d6")),
    trait: new THREE.Color(jeton("--border-strong", "#c9cbd8")),
    plein: new THREE.Color(jeton("--surface", "#ffffff")),
  });
  let couleurs = palette();

  // --- Sphère pleine, invisible mais occultante ----------------------------
  //
  // Sans elle, rien n'écrit dans le tampon de profondeur : les arcs et les
  // points de la face ARRIÈRE se voyaient au travers du globe, et l'on ne
  // pouvait plus dire quel flux passait devant. C'est le prix d'un nuage de
  // points translucide — le site vitrine l'assume, un outil d'analyse non.
  //
  // Sa teinte est celle de la surface de la page : elle ne se voit pas, elle
  // masque.
  {
    const geo = new THREE.SphereGeometry(RAYON * 0.995, 48, 32);
    const mat = new THREE.MeshBasicMaterial({ color: couleurs.plein });
    pivot.add(new THREE.Mesh(geo, mat));
    aJeter.push(geo, mat);
    matPlein = mat;
  }

  // --- Semis des terres ----------------------------------------------------
  {
    const pixels = masqueTerres(geojson);
    const surTerre = (x, y, z) => {
      const lat = (Math.asin(y) * 180) / Math.PI;
      // atan2(x, z) et non atan2(z, x) : même convention que `versVecteur`.
      const lon = (Math.atan2(x, z) * 180) / Math.PI;
      const px = Math.min(MASQUE_L - 1, Math.floor(((lon + 180) / 360) * MASQUE_L));
      const py = Math.min(MASQUE_H - 1, Math.floor(((90 - lat) / 180) * MASQUE_H));
      return pixels[py * MASQUE_L + px] === 1;
    };

    // Répartition de Fibonacci : la seule qui donne une densité uniforme sur une
    // sphère sans amas aux pôles, ce que produirait une grille lat/lon.
    const retenus = [];
    const nombreOr = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < NB_POINTS; i++) {
      const y = 1 - (i / (NB_POINTS - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = nombreOr * i;
      const x = Math.cos(th) * r;
      const z = Math.sin(th) * r;
      if (surTerre(x, y, z)) retenus.push(x, y, z);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(retenus, 3));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uCouleur: { value: couleurs.terres },
        uTaille: { value: 2.1 },
        uHauteur: { value: 600 },
        uDistance: { value: cadrage.distance },
      },
      vertexShader: `
        uniform float uTaille;
        uniform float uHauteur;
        uniform float uDistance;
        varying float vFace;
        void main() {
          vec4 vueur = modelViewMatrix * vec4(position, 1.0);
          // Les points de la face arriere sont attenues plutot que masques :
          // la sphere garde sa transparence sans z-fighting.
          vec3 n = normalize(normalMatrix * position);
          vFace = smoothstep(-0.3, 0.5, n.z);
          // uDistance : la taille d'un point suit l'echelle a laquelle on
          // regarde, sinon un globe zoome sur l'Europe garde un semis aussi
          // clairsseme que la vue mondiale.
          gl_PointSize = uTaille * (uHauteur / 600.0) * (uDistance / -vueur.z);
          gl_Position = projectionMatrix * vueur;
        }
      `,
      fragmentShader: `
        uniform vec3 uCouleur;
        varying float vFace;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = dot(c, c);
          if (d > 0.25) discard;
          gl_FragColor = vec4(uCouleur, smoothstep(0.25, 0.05, d) * (0.1 + 0.75 * vFace));
        }
      `,
    });
    sphere.add(new THREE.Points(geo, mat));
    aJeter.push(geo, mat);
    matPoints = mat;
  }

  // --- Frontières ----------------------------------------------------------
  {
    // Chaque segment n'est gardé qu'une fois : les anneaux de deux pays voisins
    // décrivent la même frontière, et la tracer deux fois la rend deux fois plus
    // sombre que les côtes. La clé est arrondie au centième de degré, ce qui
    // suffit à reconnaître deux points identiques d'un jeu à 110 m.
    const vus = new Set();
    const segments = [];
    const cle = (a, b) => {
      const f = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
      return [f(a), f(b)].sort().join("|");
    };
    for (const f of geojson.features || []) {
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      if (!Array.isArray(polys)) continue;
      for (const poly of polys) {
        for (const anneau of poly) {
          for (let i = 0; i < anneau.length - 1; i++) {
            const p = anneau[i];
            const q = anneau[i + 1];
            if (Math.abs(p[0] - q[0]) > 180) continue;
            const k = cle(p, q);
            if (vus.has(k)) continue;
            vus.add(k);
            // Très légèrement au-dessus du semis, sinon les traits clignotent
            // contre les points, à égale profondeur.
            for (const [lon, lat] of [p, q]) {
              const v = versVecteur(THREE, lon, lat, RAYON * 1.004);
              segments.push(v.x, v.y, v.z);
            }
          }
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
    const mat = new THREE.LineBasicMaterial({
      color: couleurs.trait, transparent: true, opacity: 0.35, depthWrite: false,
    });
    sphere.add(new THREE.LineSegments(geo, mat));
    aJeter.push(geo, mat);
    matTraits = mat;
  }

  // --- Atmosphère ----------------------------------------------------------
  {
    const geo = new THREE.SphereGeometry(RAYON_ATMOSPHERE, 48, 48);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uCouleur: { value: couleurs.halo } },
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
          // Fresnel base sur la VALEUR ABSOLUE du produit scalaire.
          //
          // La formule habituelle (0.6 - dot) est maximale au centre du disque
          // et non au limbe : sur un globe opaque le maillage la masque, mais
          // notre sphere est un nuage de points translucide, et ce centre
          // lumineux la traversait en un aplat plein. Ici le halo n'existe qu'a
          // la silhouette, ou la normale est perpendiculaire a la vue.
          float f = pow(1.0 - abs(dot(vNormale, vec3(0.0, 0.0, 1.0))), 3.5);
          gl_FragColor = vec4(uCouleur, clamp(f, 0.0, 1.0) * 0.5);
        }
      `,
    });
    const maille = new THREE.Mesh(geo, mat);
    maille.visible = cadrage.montrerAtmosphere;
    pivot.add(maille);
    aJeter.push(geo, mat);
    matAtmo = mat;
  }

  // --- Bulles --------------------------------------------------------------
  const vmax = Math.max(...actifs.map((n) => n.valeur));
  const parId = new Map(actifs.map((n) => [n.id, n]));

  /*
   * La taille des bulles suit l'ÉCARTEMENT des pays, pas seulement le volume.
   *
   * Sur une sphère unité, la distance entre deux points vaut l'angle qui les
   * sépare. Un rayon plus grand que la moitié de l'écart médian fait que toutes
   * les bulles se recouvrent : sur un cadre européen, onze pays serrés
   * devenaient une seule tache bleue qui avalait les arcs. Le diagramme a
   * exactement le même garde-fou, mesuré en unités de dessin.
   */
  const positionsUnite = actifs.map((n) => versVecteur(THREE, n.lon, n.lat));
  const ecarts = positionsUnite.map((a, i) => {
    let mini = Infinity;
    positionsUnite.forEach((b, j) => { if (i !== j) mini = Math.min(mini, a.angleTo(b)); });
    return mini;
  }).sort((u, v) => u - v);
  const ecartMedian = ecarts.length > 1 ? ecarts[Math.floor(ecarts.length / 2)] : Infinity;
  // 0,38 et non 0,5 : contrairement au diagramme, le globe n'écarte pas les
  // bulles qui se recouvrent — elles restent à leur position vraie. Il faut
  // donc leur laisser d'emblée la place des arcs, qui portent l'information
  // principale et que des bulles jointives avalaient entièrement.
  const rBulleMax = Math.max(R_BULLE_MIN * 1.2, Math.min(R_BULLE_MAX, ecartMedian * 0.38));

  for (const n of actifs) {
    // Rayon en racine de la valeur : c'est la SURFACE que l'œil compare, ici
    // comme sur le diagramme.
    const r = R_BULLE_MIN * 0.6 + (rBulleMax - R_BULLE_MIN * 0.6) * Math.sqrt(n.valeur / vmax);
    const geo = new THREE.SphereGeometry(r, 20, 16);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(n.couleur || jeton("--viz-1", "#2a78d6")),
      transparent: true,
      opacity: 0.92,
    });
    const maille = new THREE.Mesh(geo, mat);
    maille.position.copy(versVecteur(THREE, n.lon, n.lat, RAYON + r * 0.35));
    sphere.add(maille);
    aJeter.push(geo, mat);
    bulles.push({ noeud: n, maille, mat, r });
  }

  // --- Arcs ----------------------------------------------------------------
  // Rayon de chaque bulle, pour que les arcs partent de son bord. La marge est
  // un peu plus large à l'arrivée : la pointe du tube doit rester visible.
  const rayonDe = new Map(bulles.map((b) => [b.noeud.id, b.r]));
  const fmax = utiles.length ? Math.max(...utiles.map((l) => l.valeur)) : 1;
  const ordonnes = [...utiles].sort((a, b) => b.valeur - a.valeur);
  ordonnes.forEach((l, i) => {
    const na = parId.get(l.source);
    const nb = parId.get(l.target);
    if (!na || !nb) return;
    const rArcMax = Math.min(R_ARC_MAX, Math.max(R_ARC_MIN * 1.5, rBulleMax * PART_ARC));
    const r0 = R_ARC_MIN * 0.5 + (rArcMax - R_ARC_MIN * 0.5) * Math.sqrt(l.valeur / fmax);
    const geo = tubeEffile(
      THREE,
      versVecteur(THREE, na.lon, na.lat),
      versVecteur(THREE, nb.lon, nb.lat),
      r0,
      (rayonDe.get(l.source) || 0) * 1.05,
      (rayonDe.get(l.target) || 0) * 1.15,
      Math.max(rayonDe.get(l.source) || 0, rayonDe.get(l.target) || 0),
    );
    /*
     * Mélange NORMAL, et surtout pas additif.
     *
     * L'additif convient à un globe décoratif sur fond sombre : il y fait
     * rougeoyer les arcs. Ici le fond est blanc, et ajouter de la couleur à du
     * blanc ne change rien — les arcs restaient invisibles partout où ils
     * passaient au-dessus de la sphère, c'est-à-dire presque partout. Seuls
     * ceux qui débordaient de la silhouette, sur le fond transparent du
     * canevas, se voyaient encore : le globe mondial paraissait donc correct
     * tandis que les échanges intra-européens avaient purement disparu.
     */
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uCouleur: { value: new THREE.Color(l.couleur || jeton("--viz-1", "#2a78d6")) },
        uTemps: { value: i * 0.37 },
        uSurligne: { value: 1 },
        uAnime: { value: mouvementReduit ? 0 : 1 },
      },
      vertexShader: `
        attribute float aT;
        varying float vT;
        void main() {
          vT = aT;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uCouleur;
        uniform float uTemps;
        uniform float uSurligne;
        uniform float uAnime;
        varying float vT;
        void main() {
          // Meme grammaire que les rubans SVG : l'opacite monte a mesure que le
          // tube maigrit, de sorte que la pointe reste visible et que la
          // destination s'impose.
          float base = mix(0.28, 0.9, vT);
          // Impulsion : une bande claire parcourt le tube du depart vers
          // l'arrivee ; fract la fait boucler sans discontinuite de couleur.
          float tete = fract(uTemps * 0.35);
          float d = vT - tete;
          float imp = exp(-pow(d * 9.0, 2.0)) * uAnime;
          float a = min(1.0, base + imp * 0.6) * uSurligne;
          if (a < 0.01) discard;
          // L'impulsion eclaircit vers le blanc plutot que d'ajouter de la
          // lumiere : en melange normal, c'est ce qui la fait ressortir.
          gl_FragColor = vec4(mix(uCouleur, vec3(1.0), imp * 0.55), a);
        }
      `,
    });
    sphere.add(new THREE.Mesh(geo, mat));
    aJeter.push(geo, mat);
    matsArcs.push({ mat, source: l.source, target: l.target });
  });

  // --- Étiquettes HTML -----------------------------------------------------
  //
  // Posées sur le canevas plutôt que dessinées en 3D : le texte reste net à
  // toutes les échelles, hérite du thème et de la typographie de la page, et
  // n'oblige pas à embarquer une police en texture.
  for (const b of bulles) {
    const e = document.createElement("span");
    e.className = "globe-etiquette";
    e.textContent = b.noeud.label;
    couche.appendChild(e);
    b.etiquette = e;
  }

  // --- Orientation et interaction ------------------------------------------
  //
  // Amener (lon, lat) face à la caméra : le lacet ramène la longitude sur le
  // méridien qui fait face (+Z), le tangage remonte la latitude au centre. Voir
  // le commentaire des deux groupes plus haut pour l'ordre d'application.
  let lacet = (-centre.lon * Math.PI) / 180;
  let tangage = (centre.lat * Math.PI) / 180;
  let vitesseLacet = 0;
  let vitesseTangage = 0;
  let saisi = false;

  const borner = (v) => Math.max(-TANGAGE_MAX, Math.min(TANGAGE_MAX, v));

  let image = 0;
  let dernier = 0;
  let visible = true;
  let dansLaVue = true;
  let vivant = true;

  /**
   * Rendu à la demande.
   *
   * En mouvement réduit, aucune boucle ne tourne : la scène n'est redessinée
   * que lorsqu'elle change (glissement, redimensionnement, thème). C'est ce qui
   * permet de garder le globe MANIPULABLE tout en respectant la préférence —
   * l'alternative, tout figer, aurait retiré l'interaction à ceux qui la
   * demandent, alors que c'est le mouvement autonome qui les gêne.
   */
  let demande = 0;
  const invalider = () => {
    if (!vivant || demande) return;
    demande = requestAnimationFrame((t) => { demande = 0; dessiner(t); });
  };

  function majEtiquettes() {
    // `cote` est mis en cache par `redimensionner()` : lire la boîte englobante
    // à chaque image forcerait un recalcul de mise en page soixante fois par
    // seconde, pour une valeur qui ne change qu'au redimensionnement.
    const vue = new THREE.Vector3();
    for (const b of bulles) {
      b.maille.getWorldPosition(vue);
      const monde = vue.clone();
      vue.project(camera);
      const ex = (vue.x * 0.5 + 0.5) * cote;
      const ey = (-vue.y * 0.5 + 0.5) * cote;
      b.ecran = { x: ex, y: ey, r: Math.max(10, (b.r / RAYON) * cote * 0.42) };
      // Face cachée : le point est derrière le centre du globe vu de la caméra.
      const devant = monde.normalize().dot(camera.position.clone().normalize()) > 0.08;
      b.devant = devant;
      b.etiquette.style.transform = `translate(-50%,-50%) translate(${ex.toFixed(1)}px,${(ey - b.ecran.r - 8).toFixed(1)}px)`;
      b.etiquette.style.opacity = devant ? "1" : "0";
      b.maille.visible = true;
    }
  }

  function dessiner(horodatage) {
    const pas = dernier ? Math.min(0.05, (horodatage - dernier) / 1000) : 0;
    dernier = horodatage;

    if (!saisi) {
      lacet += vitesseLacet * pas;
      tangage = borner(tangage + vitesseTangage * pas);
      const amorti = Math.exp(-pas / FROTTEMENT);
      vitesseLacet *= amorti;
      vitesseTangage *= amorti;
      if (Math.abs(vitesseLacet) < 1e-4) vitesseLacet = 0;
      if (Math.abs(vitesseTangage) < 1e-4) vitesseTangage = 0;
    }
    sphere.rotation.y = lacet;
    pivot.rotation.x = tangage;

    if (!mouvementReduit) {
      for (const a of matsArcs) a.mat.uniforms.uTemps.value += pas;
    }
    rendu.render(scene, camera);
    majEtiquettes();
  }

  const boucle = (t) => {
    dessiner(t);
    image = requestAnimationFrame(boucle);
  };

  const relancer = () => {
    cancelAnimationFrame(image);
    image = 0;
    if (!vivant) return;
    // La boucle continue n'existe que pour l'impulsion des arcs. Sans elle,
    // rendre à la demande suffit et ne coûte rien au repos.
    if (mouvementReduit || !visible || !dansLaVue) { invalider(); return; }
    dernier = 0;
    image = requestAnimationFrame(boucle);
  };

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
    matPoints.uniforms.uHauteur.value = cote * rendu.getPixelRatio();
    invalider();
  }

  // --- Désignation ---------------------------------------------------------
  //
  // Projection écran plutôt que lancer de rayon : à trente nœuds, chercher le
  // plus proche coûte moins qu'un raycaster, et cela donne directement les
  // coordonnées où poser l'infobulle.
  function noeudSous(x, y) {
    let meilleur = null;
    let dMin = Infinity;
    for (const b of bulles) {
      if (!b.devant || !b.ecran) continue;
      const d = Math.hypot(b.ecran.x - x, b.ecran.y - y);
      if (d < b.ecran.r + 6 && d < dMin) { dMin = d; meilleur = b; }
    }
    return meilleur;
  }

  function surligner(id) {
    for (const a of matsArcs) {
      const lie = id === null || a.source === id || a.target === id;
      a.mat.uniforms.uSurligne.value = lie ? 1 : 0.07;
    }
    const relies = new Set();
    if (id !== null) {
      for (const a of matsArcs) {
        if (a.source === id || a.target === id) { relies.add(a.source); relies.add(a.target); }
      }
    }
    for (const b of bulles) {
      b.mat.opacity = id === null || b.noeud.id === id || relies.has(b.noeud.id) ? 0.92 : 0.2;
      b.etiquette.classList.toggle("estompe",
        id !== null && b.noeud.id !== id && !relies.has(b.noeud.id));
    }
    invalider();
  }

  let survole = null;
  let dernierX = 0;
  let dernierY = 0;
  let dernierT = 0;

  const surPointerMove = (evt) => {
    // `offsetX/offsetY` sont relatifs au canevas, y compris pendant une capture
    // de pointeur : aucune boîte englobante à relire, et rien à corriger quand
    // la page défile en cours de geste.
    const x = evt.offsetX;
    const y = evt.offsetY;

    if (saisi) {
      const dx = evt.clientX - dernierX;
      const dy = evt.clientY - dernierY;
      lacet += dx * SENSIBILITE;
      tangage = borner(tangage + dy * SENSIBILITE);
      const dt = Math.max(8, evt.timeStamp - dernierT) / 1000;
      vitesseLacet = (dx * SENSIBILITE) / dt;
      vitesseTangage = (dy * SENSIBILITE) / dt;
      dernierX = evt.clientX;
      dernierY = evt.clientY;
      dernierT = evt.timeStamp;
      invalider();
      return;
    }

    const b = noeudSous(x, y);
    if (b !== survole) {
      survole = b;
      surligner(b ? b.noeud.id : null);
      boite.classList.toggle("designe", Boolean(b));
    }
    if (b) {
      infobulle.innerHTML =
        `<b>${esc(b.noeud.titre || b.noeud.label)}</b><br>${esc(fmt(b.noeud.valeur))}`;
      infobulle.style.transform = `translate(${x.toFixed(0)}px,${y.toFixed(0)}px)`;
      infobulle.classList.add("visible");
    } else {
      infobulle.classList.remove("visible");
    }
  };

  const surPointerDown = (evt) => {
    saisi = true;
    dernierX = evt.clientX;
    dernierY = evt.clientY;
    dernierT = evt.timeStamp;
    vitesseLacet = 0;
    vitesseTangage = 0;
    rendu.domElement.setPointerCapture(evt.pointerId);
    boite.classList.add("saisi");
    infobulle.classList.remove("visible");
  };

  const surPointerUp = (evt) => {
    if (!saisi) return;
    saisi = false;
    if (rendu.domElement.hasPointerCapture(evt.pointerId)) {
      rendu.domElement.releasePointerCapture(evt.pointerId);
    }
    boite.classList.remove("saisi");
    // Main immobile avant le lâcher : on repose le globe, on ne le lance pas.
    if (evt.timeStamp - dernierT > 120) { vitesseLacet = 0; vitesseTangage = 0; }
    if (mouvementReduit) { vitesseLacet = 0; vitesseTangage = 0; invalider(); }
    else relancer();
  };

  const surClic = (evt) => {
    if (!onClick) return;
    const b = noeudSous(evt.offsetX, evt.offsetY);
    if (b) onClick(b.noeud.id);
  };

  // Clavier : les flèches font tourner le globe quand le canevas a le focus.
  const surTouche = (evt) => {
    const PAS = 0.12;
    const gestes = {
      ArrowLeft: () => { lacet -= PAS; },
      ArrowRight: () => { lacet += PAS; },
      ArrowUp: () => { tangage = borner(tangage - PAS); },
      ArrowDown: () => { tangage = borner(tangage + PAS); },
    };
    if (!gestes[evt.key]) return;
    evt.preventDefault();
    gestes[evt.key]();
    invalider();
  };

  const cible = rendu.domElement;
  cible.addEventListener("pointerdown", surPointerDown);
  cible.addEventListener("pointermove", surPointerMove);
  cible.addEventListener("pointerup", surPointerUp);
  cible.addEventListener("pointercancel", surPointerUp);
  cible.addEventListener("pointerleave", () => {
    if (!saisi) { survole = null; surligner(null); infobulle.classList.remove("visible"); }
  });
  cible.addEventListener("click", surClic);
  cible.addEventListener("keydown", surTouche);

  const surVisibilite = () => { visible = document.visibilityState === "visible"; relancer(); };
  document.addEventListener("visibilitychange", surVisibilite);

  const obsTaille = new ResizeObserver(() => redimensionner());
  obsTaille.observe(boite);
  const obsVue = new IntersectionObserver(([e]) => {
    dansLaVue = e?.isIntersecting ?? true;
    relancer();
  }, { threshold: 0 });
  obsVue.observe(boite);

  const desabonner = onThemeChange(() => {
    couleurs = palette();
    matPoints.uniforms.uCouleur.value = couleurs.terres;
    matAtmo.uniforms.uCouleur.value = couleurs.halo;
    matTraits.color = couleurs.trait;
    matPlein.color = couleurs.plein;
    invalider();
  });

  redimensionner();
  relancer();

  // Alternative textuelle, la même que celle du diagramme.
  hote.appendChild(tableauFlux(ordonnes, parId, fmt, resume));
  hote.insertAdjacentHTML("beforeend",
    `<p class="legende-flux">Chaque arc part <b>large de l'origine</b> et s'affine vers la
     <b>destination</b>. Faites glisser le globe pour le tourner, survolez un pays pour n'en garder
     que les échanges.</p>`);

  const instance = {
    hote,
    detruire() {
      if (!vivant) return;
      vivant = false;
      cancelAnimationFrame(image);
      cancelAnimationFrame(demande);
      obsTaille.disconnect();
      obsVue.disconnect();
      document.removeEventListener("visibilitychange", surVisibilite);
      desabonner();
      // three ne libère rien tout seul : chaque géométrie et chaque matériau
      // détient un tampon GPU, et le contexte doit être rendu explicitement.
      for (const o of aJeter) o.dispose();
      rendu.dispose();
      rendu.forceContextLoss();
      rendu.domElement.remove();
      globesVivants.delete(instance);
    },
    focus(id) {
      const n = parId.get(id);
      if (!n) return;
      lacet = (-n.lon * Math.PI) / 180;
      tangage = borner((n.lat * Math.PI) / 180);
      vitesseLacet = 0;
      vitesseTangage = 0;
      invalider();
    },
  };
  globesVivants.add(instance);
  return instance;
}
