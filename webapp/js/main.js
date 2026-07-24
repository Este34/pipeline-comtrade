// Point d'entrée : initialise DuckDB-WASM + libellés FR, gère la navigation
// par onglets et le montage paresseux de chaque vue.
import { initDB } from "./db.js";
import { loadLabels } from "./labels.js";
import { setStatus, wireBackToTop } from "./ui.js";
import { mountPalette } from "./palette.js";
import { purgerCartes } from "./map.js";

import * as profil from "./views/profil-pays.js";
import * as bilateral from "./views/bilateral.js";
import * as produit from "./views/produit.js";
import * as carto from "./views/carto-series.js";
import * as mineraux from "./views/mineraux-critiques.js";
import * as flux from "./views/flux-sankey.js";

const VIEWS = { profil, bilateral, produit, carto, mineraux, flux };
const monte = {}; // vues déjà montées (montage unique)

let ctx = null;

async function activer(nom) {
  // Une carte dont le conteneur a été remplacé par une nouvelle analyse reste
  // sinon vivante, avec son animation, jusqu'à saturation du navigateur.
  purgerCartes();

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
      container.innerHTML = `<div class="empty">Erreur au chargement de la vue : ${e.message}</div>`;
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

async function boot() {
  try {
    setStatus("Chargement des libellés et de la base de données…");
    const [labels] = await Promise.all([loadLabels(), initDB()]);
    ctx = { labels };
    setStatus("Prêt. Sélectionnez vos filtres puis lancez l'analyse.");
    initTabs();
    wireBackToTop();

    const palette = mountPalette({ labels, onGoToView: activer, onOpenCountry: ouvrirPaysDansProfil });
    document.getElementById("paletteBtn").addEventListener("click", () => palette.open());
    if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
      document.getElementById("kbdHint").textContent = "⌘K";
    }

    await activer("flux");
  } catch (e) {
    setStatus("Erreur d'initialisation : " + e.message, true);
    console.error(e);
  }
}

boot();
