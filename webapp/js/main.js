// Point d'entrée : initialise DuckDB-WASM + libellés FR, gère la navigation
// par onglets et le montage paresseux de chaque vue.
import { initDB } from "./db.js";
import { loadLabels } from "./labels.js";
import { setStatus } from "./ui.js";

import * as profil from "./views/profil-pays.js";
import * as bilateral from "./views/bilateral.js";
import * as produit from "./views/produit.js";
import * as carto from "./views/carto-series.js";
import * as mineraux from "./views/mineraux-critiques.js";

const VIEWS = { profil, bilateral, produit, carto, mineraux };
const monte = {}; // vues déjà montées (montage unique)

let ctx = null;

async function activer(nom) {
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

async function boot() {
  try {
    setStatus("Chargement des libellés et de la base de données…");
    const [labels] = await Promise.all([loadLabels(), initDB()]);
    ctx = { labels };
    setStatus("Prêt. Sélectionnez vos filtres puis lancez l'analyse.");
    initTabs();
    await activer("profil");
  } catch (e) {
    setStatus("Erreur d'initialisation : " + e.message, true);
    console.error(e);
  }
}

boot();
