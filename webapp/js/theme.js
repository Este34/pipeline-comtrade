// Thème clair / sombre.
//
// Trois états, pas deux : « auto » suit le réglage du système d'exploitation,
// « clair » et « sombre » le forcent. Sans l'état auto, un utilisateur en mode
// sombre système découvrirait le site en clair à chaque première visite ; sans
// les états forcés, il ne pourrait pas en sortir pour une capture ou une
// projection. Le choix est mémorisé localement (aucune donnée n'est transmise).
//
// L'attribut `data-theme` est posé sur <html> et non sur <body> : la feuille de
// style le lit en `:root[data-theme="dark"]`, ce qui doit rester plus
// spécifique que la requête média `prefers-color-scheme`.

const CLE = "comtrade:theme";
const MODES = ["auto", "clair", "sombre"];
const ATTR = { clair: "light", sombre: "dark" };

const abonnes = new Set();
const requeteSysteme = window.matchMedia("(prefers-color-scheme: dark)");

let mode = lireMemoire();

function lireMemoire() {
  try {
    const v = localStorage.getItem(CLE);
    return MODES.includes(v) ? v : "auto";
  } catch {
    // Navigation privée ou stockage refusé : le thème reste en auto pour la
    // session plutôt que de faire échouer le démarrage de l'application.
    return "auto";
  }
}

function ecrireMemoire(v) {
  try {
    localStorage.setItem(CLE, v);
  } catch {
    /* stockage indisponible : le choix vaut pour la session en cours */
  }
}

// Thème réellement appliqué (« clair » ou « sombre »), une fois l'auto résolu.
export function themeEffectif() {
  if (mode !== "auto") return mode;
  return requeteSysteme.matches ? "sombre" : "clair";
}

export function modeCourant() {
  return mode;
}

function appliquer() {
  const racine = document.documentElement;
  if (mode === "auto") racine.removeAttribute("data-theme");
  else racine.setAttribute("data-theme", ATTR[mode]);
  const effectif = themeEffectif();
  // Les abonnés (Chart.js, SVG dessinés à la main) relisent les jetons CSS :
  // ils doivent être notifiés APRÈS que l'attribut a changé.
  for (const fn of abonnes) {
    try {
      fn(effectif);
    } catch (e) {
      // Un abonné en échec ne doit pas empêcher les suivants de se redessiner.
      console.error("Redessin après changement de thème :", e);
    }
  }
}

export function setMode(v) {
  if (!MODES.includes(v)) return;
  mode = v;
  ecrireMemoire(v);
  appliquer();
}

// Fait tourner auto → clair → sombre → auto.
export function cycler() {
  setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
  return mode;
}

// S'abonner aux changements de thème. Renvoie la fonction de désabonnement.
export function onThemeChange(fn) {
  abonnes.add(fn);
  return () => abonnes.delete(fn);
}

// Valeur d'un jeton CSS, lue sur <html>. C'est le seul point d'accès aux
// couleurs pour le JS : aucune couleur de données n'est écrite en dur dans les
// modules de graphes, sans quoi le thème sombre les laisserait inchangées.
export function jeton(nom, repli = "") {
  const v = getComputedStyle(document.documentElement).getPropertyValue(nom).trim();
  return v || repli;
}

// Raccourcis vers les familles de couleurs validées (voir css/styles.css).
export const paletteViz = () => Array.from({ length: 8 }, (_, i) => jeton(`--viz-${i + 1}`));
export const paletteStades = () => Array.from({ length: 4 }, (_, i) => jeton(`--stade-${i + 1}`));
export const rampeSequentielle = () => Array.from({ length: 6 }, (_, i) => jeton(`--ramp-${i + 1}`));

// Câble le bouton de bascule et tient son libellé à jour.
export function wireThemeToggle(bouton) {
  if (!bouton) return;
  const ICONES = { auto: "◐", clair: "☀", sombre: "☾" };
  const TITRES = {
    auto: "Thème : automatique (suit le système). Cliquer pour forcer le thème clair.",
    clair: "Thème : clair. Cliquer pour passer au thème sombre.",
    sombre: "Thème : sombre. Cliquer pour revenir au thème automatique.",
  };
  function majBouton() {
    bouton.textContent = ICONES[mode];
    bouton.title = TITRES[mode];
    bouton.setAttribute("aria-label", TITRES[mode]);
  }
  bouton.addEventListener("click", () => {
    cycler();
    majBouton();
  });
  majBouton();
}

// Le système peut changer de thème pendant la session (bascule automatique au
// coucher du soleil) : en mode auto, l'application doit suivre.
requeteSysteme.addEventListener("change", () => {
  if (mode === "auto") appliquer();
});

// Appliqué dès l'import, avant le premier rendu, pour éviter un flash clair.
appliquer();
