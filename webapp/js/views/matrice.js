// Vue « Matrice » : une heatmap pays × minéraux.
//
// Toutes les autres vues traitent un minéral (ou un panier) à la fois. Celle-ci
// répond à la question inverse — « quels pays comptent, sur quels minéraux » —
// qui demande de tout voir d'un coup. C'est une vue de BALAYAGE : on y repère
// une concentration ou une absence, puis on va la comprendre ailleurs.
//
// Trois normalisations, parce que la même grille répond à trois questions
// différentes et qu'il serait faux de laisser croire qu'une seule suffit :
//   - valeur absolue     : qui pèse le plus, toutes matières confondues ;
//   - % de la ligne      : de quoi le commerce d'un pays est-il fait ;
//   - % de la colonne    : quelle part mondiale un pays détient sur un minéral.
//
// Lue sur le PRÉ-AGRÉGAT (partenaire World) : la question ne porte pas sur le
// partenaire bilatéral, donc ouvrir les partitions du détail serait payer une
// jointure dont on jette le résultat.
import { query, srcCritical, srcCriticalAgg, clauseCodes } from "../db.js";
import { fmtMetric, axisFmt, pct, downloadCsv } from "../format.js";
import { pays, codesPour, mineraux, stades } from "../labels.js";
import {
  selectHTML, anneeOptions, fluxOptions, metricOptions, ctrl, kpisHTML, card,
  renderChips, skeletonKpis, mineralOptions, stadeOptions, multiSelectHTML,
  wireMultiSelect, viewHead,
} from "../ui.js";
import { heatmap } from "../heatmap.js";
import { estUE27 } from "../geo.js";

const NORMALISATIONS = [
  { value: "absolu", label: "Valeur absolue" },
  { value: "ligne", label: "% de la ligne (profil du pays)" },
  { value: "colonne", label: "% de la colonne (part mondiale)" },
];
const PERIMETRES_PAYS = [
  { value: "monde", label: "Tous pays" },
  { value: "ue27", label: "UE27 seulement" },
];

export async function mount(container, { labels }) {
  const TOUS_STADES = stades(labels).map((s) => s.id);
  const TOUS_MINERAUX = mineraux(labels);
  // Sélection de départ : les filières les plus discutées côté matières
  // critiques, restreintes à ce que le référentiel connaît réellement.
  const DEFAUT = ["Cuivre", "Lithium", "Cobalt", "Nickel", "Terres rares", "Graphite", "Manganèse", "Silicium"]
    .filter((m) => TOUS_MINERAUX.includes(m));

  container.innerHTML = `
    ${viewHead({
      titre: "Matrice pays × minéraux",
      lede: `Une grille de balayage : chaque cellule croise un pays et un minéral. Elle sert à
        repérer une concentration, une spécialisation ou une absence — puis à aller la comprendre
        dans les autres vues.`,
      meta: `Lecture : la couleur encode une grandeur sur une <b>échelle logarithmique</b>, sans quoi
        les premiers pays écraseraient toute la grille et 95 % des cellules tomberaient dans le même
        palier. Une cellule « – » signifie <b>aucun échange déclaré</b>, ce qui n'est pas la même
        chose qu'un échange nul.`,
    })}

    <div class="filterbar">
      ${ctrl("Année", selectHTML("mx-annee", anneeOptions(), 2023))}
      ${ctrl("Flux", selectHTML("mx-flux", fluxOptions(), "M"))}
      ${ctrl("Mesure", selectHTML("mx-metric", metricOptions(), "valeur"))}
      ${ctrl("Pays affichés", selectHTML("mx-top", [
        { value: 15, label: "15 premiers" }, { value: 25, label: "25 premiers" },
        { value: 40, label: "40 premiers" },
      ], 25))}
      ${ctrl("Périmètre", selectHTML("mx-perimetre", PERIMETRES_PAYS, "monde"))}
      ${ctrl("Normalisation", selectHTML("mx-norm", NORMALISATIONS, "absolu"))}
      <button class="btn" id="mx-go">Actualiser</button>
    </div>

    <details class="panier" id="mx-panier" open>
      <summary>Colonnes et périmètre produit <span id="mx-resume"></span></summary>
      <div class="filterbar">
        <div class="ctrl grow"><label>Minéraux (colonnes)</label>
          ${multiSelectHTML("mx-min", mineralOptions(labels), DEFAUT)}</div>
        <div class="ctrl grow"><label>Stades de la chaîne de valeur</label>
          ${multiSelectHTML("mx-stade", stadeOptions(labels), TOUS_STADES)}</div>
      </div>
      <div class="note" id="mx-panier-note"></div>
    </details>

    <div class="chips" id="mx-chips" aria-label="Filtres actifs"></div>
    <div id="mx-res"></div>`;

  const res = container.querySelector("#mx-res");
  const chipsEl = container.querySelector("#mx-chips");
  const resumeEl = container.querySelector("#mx-resume");
  const panierNote = container.querySelector("#mx-panier-note");
  const lire = (id) => container.querySelector(`#mx-${id}`);
  const valeurs = (id) => [...lire(id).selectedOptions].map((o) => o.value);

  const msMin = wireMultiSelect("mx-min");
  const msStade = wireMultiSelect("mx-stade");

  // Colonne de tri courante (clé de minéral), ou null pour le tri par total.
  let triColonne = null;

  function minerauxRetenus() {
    const choisis = valeurs("min");
    return choisis.length ? choisis : TOUS_MINERAUX;
  }

  // Codes HS6 par minéral, restreints aux stades cochés. Calculé une fois et
  // partagé entre la clause SQL et l'agrégation : les deux DOIVENT reposer sur
  // la même liste, sinon un total de colonne ne correspondrait plus à sa somme.
  function codesParMineral() {
    const sts = valeurs("stade");
    const out = new Map();
    for (const m of minerauxRetenus()) {
      const codes = codesPour(labels, { mineraux: [m], stades: sts });
      if (codes.length) out.set(m, codes);
    }
    return out;
  }

  function majPanier() {
    const parMin = codesParMineral();
    const total = [...parMin.values()].reduce((s, c) => s + c.length, 0);
    resumeEl.textContent = `— ${parMin.size} minéral(aux) · ${total} codes HS6`;
    panierNote.innerHTML = parMin.size
      ? `<b>${parMin.size}</b> colonne(s), <b>${total}</b> position(s) HS6 au total. Un minéral dont
         aucune position ne relève des stades cochés est retiré de la grille plutôt qu'affiché vide.`
      : `<b>Sélection vide</b> : aucun minéral ne possède de position HS6 dans les stades cochés.`;
  }

  function majChips() {
    const items = [
      { label: "Minéraux", value: String(codesParMineral().size),
        onReset: () => { for (const o of lire("min").options) o.selected = DEFAUT.includes(o.value); msMin.sync(); analyser(); } },
      { label: "Année", value: lire("annee").value,
        onReset: () => { lire("annee").value = "2023"; analyser(); } },
      { label: "Flux", value: lire("flux").selectedOptions[0].text,
        onReset: () => { lire("flux").value = "M"; analyser(); } },
      { label: "Mesure", value: lire("metric").selectedOptions[0].text,
        onReset: () => { lire("metric").value = "valeur"; analyser(); } },
      { label: "Normalisation", value: lire("norm").selectedOptions[0].text,
        onReset: () => { lire("norm").value = "absolu"; analyser(); } },
    ];
    const sts = valeurs("stade");
    if (sts.length < TOUS_STADES.length) {
      items.splice(1, 0, { label: "Stades", value: `${sts.length}/${TOUS_STADES.length}`,
        onReset: () => { msStade.setTout(true); analyser(); } });
    }
    if (lire("perimetre").value !== "monde") {
      items.splice(1, 0, { label: "Périmètre", value: "UE27",
        onReset: () => { lire("perimetre").value = "monde"; analyser(); } });
    }
    if (triColonne) {
      items.push({ label: "Trié sur", value: triColonne, onReset: () => { triColonne = null; analyser(); } });
    }
    renderChips(chipsEl, items);
  }

  async function analyser() {
    const annee = Number(lire("annee").value);
    const flux = lire("flux").value;
    const metric = lire("metric").value;
    const topN = Number(lire("top").value);
    const norm = lire("norm").value;
    const perimetre = lire("perimetre").value;
    majPanier();
    majChips();
    res.innerHTML = "";
    skeletonKpis(res, 3);

    const parMin = codesParMineral();
    if (!parMin.size) {
      res.innerHTML = `<div class="empty">Aucun minéral sélectionné n'a de position HS6 dans les
        stades cochés. Cochez davantage de stades, ou d'autres minéraux.</div>`;
      return;
    }

    // Un seul balayage : tous les codes de toutes les colonnes d'un coup, le
    // rattachement code → minéral se faisant ensuite en mémoire. Une requête
    // par minéral multiplierait les allers-retours sans rien gagner.
    const tousCodes = [...new Set([...parMin.values()].flat())];
    const requete = (src, sup) => `
      SELECT reporterISO3, cmdCode, SUM(primaryValue) valeur, SUM(netWgt) poids
      FROM ${src}
      WHERE ${clauseCodes(tousCodes)} AND flowCode = '${flux}' AND period = ${annee}${sup}
      GROUP BY 1, 2`;

    // Repli sur le détail bilatéral si le pré-agrégat manque (archive de
    // données antérieure à son introduction) : même résultat, simplement plus
    // lent. Le dire vaut mieux que de tomber en erreur ou de mentir par
    // omission sur la performance.
    let rows;
    let degrade = false;
    try {
      rows = await query(requete(srcCriticalAgg(), ""));
    } catch {
      degrade = true;
      rows = await query(requete(srcCritical([annee]),
        " AND partnerCode = '0' AND reporterISO3 IS NOT NULL"));
    }

    // code HS6 -> minéral (un code peut appartenir à plusieurs colonnes si
    // l'utilisateur a coché des minéraux qui partagent une position ; on
    // l'attribue alors à chacune, et on le signale).
    const minerauxDuCode = new Map();
    for (const [m, codes] of parMin) {
      for (const c of codes) {
        if (!minerauxDuCode.has(c)) minerauxDuCode.set(c, []);
        minerauxDuCode.get(c).push(m);
      }
    }
    const partages = [...minerauxDuCode.values()].filter((l) => l.length > 1).length;

    const brut = new Map(); // "ISO3\u0001Minéral" -> mesure
    const parPays = new Map();
    const parMineral = new Map();
    const cle = (p, m) => `${p}\u0001${m}`;
    for (const r of rows) {
      const iso = r.reporterISO3;
      if (!iso) continue;
      if (perimetre === "ue27" && !estUE27(iso)) continue;
      const v = r[metric] || 0;
      if (v <= 0) continue;
      for (const m of minerauxDuCode.get(r.cmdCode) || []) {
        brut.set(cle(iso, m), (brut.get(cle(iso, m)) || 0) + v);
        parPays.set(iso, (parPays.get(iso) || 0) + v);
        parMineral.set(m, (parMineral.get(m) || 0) + v);
      }
    }

    const colonnes = [...parMin.keys()]
      .filter((m) => parMineral.has(m))
      .sort((a, b) => (parMineral.get(b) || 0) - (parMineral.get(a) || 0))
      .map((m) => ({ cle: m, label: m }));

    let paysTries = [...parPays.entries()].sort((a, b) => b[1] - a[1]);
    if (triColonne) {
      paysTries = paysTries.sort(
        (a, b) => (brut.get(cle(b[0], triColonne)) || 0) - (brut.get(cle(a[0], triColonne)) || 0));
    }
    const retenus = paysTries.slice(0, topN);
    const lignes = retenus.map(([iso]) => ({ cle: iso, label: pays(labels, iso) }));

    const totalGlobal = [...parPays.values()].reduce((s, v) => s + v, 0);
    const totalAffiche = retenus.reduce((s, [, v]) => s + v, 0);
    const top5 = paysTries.slice(0, 5).reduce((s, [, v]) => s + v, 0);

    res.innerHTML = "";

    if (degrade) {
      res.insertAdjacentHTML("beforeend", `<div class="note note-alerte">
        <b>Mode dégradé</b> : le pré-agrégat <code>critical_agg/</code> est absent de ce jeu de
        données, la vue lit donc le détail bilatéral. Les résultats sont les mêmes, l'affichage est
        seulement plus lent. Pour le rétablir :
        <code>python clean/clean_export.py --critical</code>, puis republier l'archive.</div>`);
    }

    const sensMot = flux === "M" ? "importations" : "exportations";
    const kpiWrap = document.createElement("div");
    kpiWrap.innerHTML = kpisHTML([
      { label: `Total ${sensMot} ${annee} (${perimetre === "ue27" ? "UE27" : "monde"})`, value: fmtMetric(totalGlobal, metric) },
      { label: "Pays actifs", value: String(parPays.size) },
      { label: "Concentration (5 premiers pays)", value: pct(top5, totalGlobal),
        cls: totalGlobal && top5 / totalGlobal > 0.7 ? "neg" : "" },
    ], 3);
    res.appendChild(kpiWrap);

    // Normalisation : la valeur AFFICHÉE change, la valeur d'origine reste
    // accessible en infobulle pour que la grille demeure vérifiable.
    const valeurBrute = (p, m) => brut.get(cle(p, m)) || 0;
    const affichee = {
      absolu: valeurBrute,
      ligne: (p, m) => (parPays.get(p) ? (100 * valeurBrute(p, m)) / parPays.get(p) : 0),
      colonne: (p, m) => (parMineral.get(m) ? (100 * valeurBrute(p, m)) / parMineral.get(m) : 0),
    }[norm];

    const enPourcent = norm !== "absolu";
    const fmtCellule = enPourcent
      ? (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(".", ",")) + " %"
      : axisFmt(metric);

    const legendes = {
      absolu: "Chaque cellule : montant échangé par ce pays sur ce minéral.",
      ligne: "Chaque LIGNE totalise 100 % : de quoi le commerce de ce pays est-il fait.",
      colonne: "Chaque COLONNE totalise 100 % sur l'ensemble des pays actifs : part mondiale détenue.",
    };

    const titre = `${flux === "M" ? "Importations" : "Exportations"} ${annee} — ${lignes.length} pays × ${colonnes.length} minéraux`;
    const cHeat = card(titre, "mx-heat");
    res.appendChild(cHeat);
    heatmap(cHeat.querySelector(".card-body"), {
      lignes, colonnes,
      valeur: affichee,
      brut: valeurBrute,
    }, {
      fmt: (v) => fmtMetric(v, metric),
      fmtCellule,
      onTri: (c) => { triColonne = c; analyser(); },
      triCourant: triColonne,
      legende: legendes[norm] +
        (norm === "colonne" ? " La colonne peut ne pas atteindre 100 % : seuls les pays affichés sont visibles." : ""),
    });

    if (partages) {
      cHeat.querySelector(".card-body").insertAdjacentHTML("beforeend",
        `<div class="note methodo" style="margin-top:12px"><b>${partages}</b> position(s) HS6
         relève(nt) de plusieurs minéraux sélectionnés et sont comptées dans chaque colonne
         concernée. La somme des colonnes dépasse donc le total réel : comparez les colonnes entre
         elles, pas leur somme.</div>`);
    }

    const lignesCsv = [];
    for (const l of lignes) {
      for (const c of colonnes) {
        lignesCsv.push({
          pays: l.label, iso3: l.cle, mineral: c.cle,
          mesure: Math.round(valeurBrute(l.cle, c.cle)),
          part_ligne_pct: parPays.get(l.cle) ? (100 * valeurBrute(l.cle, c.cle) / parPays.get(l.cle)).toFixed(2) : "",
          part_colonne_pct: parMineral.get(c.cle) ? (100 * valeurBrute(l.cle, c.cle) / parMineral.get(c.cle)).toFixed(2) : "",
        });
      }
    }
    cHeat.querySelector("[data-export]").addEventListener("click", () =>
      downloadCsv(`matrice_${flux}_${annee}_${metric}.csv`, lignesCsv));

    // Le total affiché n'est pas le total mondial : le dire évite qu'on lise
    // une part de 100 % là où il n'y en a qu'une fraction.
    if (totalAffiche < totalGlobal) {
      res.insertAdjacentHTML("beforeend", `<div class="note">Les ${lignes.length} pays affichés
        représentent <b>${pct(totalAffiche, totalGlobal)}</b> du total du périmètre. Augmentez
        « Pays affichés » pour en voir davantage.</div>`);
    }
  }

  container.querySelector("#mx-go").addEventListener("click", analyser);
  ["annee", "flux", "metric", "top", "norm", "perimetre", "min", "stade"].forEach((id) =>
    lire(id).addEventListener("change", analyser));

  await analyser();
}
