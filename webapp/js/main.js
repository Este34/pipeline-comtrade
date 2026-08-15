// Point d'entrée : initialise DuckDB-WASM + libellés FR, gère la navigation
// par onglets et le montage paresseux de chaque vue.
import { initDB } from "./db.js";
import { esc } from "./format.js";
import { loadLabels } from "./labels.js";
import { setStatus, wireBackToTop } from "./ui.js";
import { mountPalette } from "./palette.js";
import { purgerCartes } from "./map.js";
// Volontairement importé depuis la bascule et NON depuis globe.js : ce dernier
// n'entre ainsi jamais dans le chargement initial des onglets sans globe.
import { purgerAffichages } from "./diagramme-flux.js";
import { wireThemeToggle } from "./theme.js";

import * as profil from "./views/profil-pays.js";
import * as bilateral from "./views/bilateral.js";
import * as produit from "./views/produit.js";
import * as carto from "./views/carto-series.js";
import * as mineraux from "./views/mineraux-critiques.js";
import * as flux from "./views/flux-sankey.js";
import * as matrice from "./views/matrice.js";
import * as europe from "./views/europe.js";

const VIEWS = { profil, bilateral, produit, carto, mineraux, flux, matrice, europe };
const monte = {}; // vues déjà montées (montage unique)

let ctx = null;

async function activer(nom) {
  // Une carte dont le conteneur a été remplacé par une nouvelle analyse reste
  // sinon vivante, avec son animation, jusqu'à saturation du navigateur. Un
  // globe pose le même problème en pire : son contexte WebGL est une ressource
  // que le navigateur ne distribue qu'à une poignée d'exemplaires.
  purgerCartes();
  purgerAffichages();

  document.querySelectorAll(".tab").forEach((t) => {
    const actif = t.dataset.view === nom;
    t.classList.toggle("active", actif);
    t.setAttribute("aria-selected", actif ? "true" : "false");
    t.tabIndex = actif ? 0 : -1;
  });
  document.querySelectorAll(".page").forEach((p) => {
    p.classList.toggle("active", p.id === `view-${nom}`);
  });

  if (!monte[nom]) {
    const container = document.getElementById(`view-${nom}`);
    try {
      await VIEWS[nom].mount(container, ctx);
      monte[nom] = true;
    } catch (e) {
      container.innerHTML = `<div class="empty">Erreur au chargement de la vue : ${esc(e.message)}</div>`;
      console.error(e);
    }
  }
}

function initTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((t) => t.addEventListener("click", () => activer(t.dataset.view)));
  // Navigation clavier ARIA (flèches, Home/End).
  document.getElementById("tabs").addEventListener("keydown", (e) => {
    const i = tabs.findIndex((t) => t.classList.contains("active"));
    let j = null;
    if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = tabs.length - 1;
    if (j !== null) {
      e.preventDefault();
      tabs[j].focus();
      activer(tabs[j].dataset.view);
    }
  });
}

// Palette de commandes : « Ouvrir le profil de X » bascule sur la vue Profil
// pays et notifie ce module via un événement (découplage simple, sans import
// circulaire entre main.js et views/profil-pays.js).
async function ouvrirPaysDansProfil(iso3) {
  await activer("profil");
  window.dispatchEvent(new CustomEvent("comtrade:open-country", { detail: { iso3 } }));
}

// Pied de page : source, période couverte et date de mise à jour du jeu de
// données, lus depuis data/reference/dataset_fr.json. Sans manifeste (anciens
// déploiements), on laisse le repli statique déjà présent dans le HTML.
function afficherFicheDataset(dataset) {
  const cible = document.getElementById("datasetMeta");
  if (!cible || !dataset) return;

  // Une ligne par champ : la fiche occupe une colonne étroite du pied de page.
  const lignes = [];
  if (dataset.source) lignes.push(`Source&nbsp;: <b>${dataset.source}</b>`);
  if (dataset.periode && dataset.periode.debut && dataset.periode.fin) {
    lignes.push(`Période&nbsp;: <b>${dataset.periode.debut}&nbsp;–&nbsp;${dataset.periode.fin}</b>`);
  }
  if (dataset.date_maj) {
    const d = new Date(dataset.date_maj + "T00:00:00");
    const jolie = Number.isNaN(d.getTime())
      ? dataset.date_maj
      : d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    lignes.push(`Mise à jour&nbsp;: <b>${jolie}</b>`);
  }
  if (lignes.length) cible.innerHTML = lignes.join("<br>");
}

async function boot() {
  // Les commandes qui ne dépendent d'aucune donnée sont câblées AVANT le
  // chargement : thème, retour en haut, navigation par onglets. Placées après,
  // elles disparaissaient avec la base — un jeu de données absent rendait alors
  // le bouton de thème et le clavier inopérants, ce qui n'a aucune raison
  // d'être lié.
  wireThemeToggle(document.getElementById("themeBtn"));
  wireBackToTop();
  initTabs();

  try {
    setStatus("Chargement des libellés et de la base de données…");
    const [labels] = await Promise.all([loadLabels(), initDB()]);
    ctx = { labels };
    afficherFicheDataset(labels.dataset);
    setStatus("Prêt. Sélectionnez vos filtres puis lancez l'analyse.");

    const palette = mountPalette({ labels, onGoToView: activer, onOpenCountry: ouvrirPaysDansProfil });
    document.getElementById("paletteBtn").addEventListener("click", () => palette.open());
    if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
      document.getElementById("kbdHint").textContent = "⌘K";
    }

    // Une analyse partagée arrive avec son onglet dans le hash (#vue=flux&…) :
    // l'ouvrir directement évite que le lien ne retombe sur la vue par défaut,
    // qui rejouerait ses propres filtres avant d'être remplacée.
    const vueHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("vue");
    await activer(VIEWS[vueHash] ? vueHash : "flux");
  } catch (e) {
    // Le cas de loin le plus fréquent est un jeu de données absent : le dépôt
    // ne versionne ni les Parquet ni le binaire WebAssembly, tous deux fournis
    // par l'archive de release. Le dire explicitement évite de chercher un bug
    // là où il n'y a qu'un fichier manquant.
    setStatus("Erreur d'initialisation : " + e.message, true);
    const hote = document.getElementById("view-flux");
    if (hote && !hote.children.length) {
      hote.innerHTML = `<div class="view-head">
        <h2>Données indisponibles</h2>
        <p class="view-lede">L'application n'a pas pu ouvrir sa base de données locale.</p>
        <p class="view-meta">Le dépôt ne contient ni les fichiers Parquet
        (<code>webapp/data/parquet/</code>) ni le binaire DuckDB-WebAssembly
        (<code>webapp/vendor/duckdb-wasm/duckdb-eh.wasm</code>) : les deux proviennent de l'archive
        de données publiée en release. Récupérez <code>webapp-assets.tar.gz</code> et décompressez-la
        dans <code>webapp/</code>, ou rétablissez la jonction locale vers le dossier de données.
        <br>Détail technique : <b>${e.message}</b></p></div>`;
    }
    console.error(e);
  }
}

boot();
