// Tests des calculs géographiques et des clauses SQL de périmètre.
// Ces fonctions n'ont aucune dépendance au DOM : elles sont testables telles quelles.
import test from "node:test";
import assert from "node:assert/strict";

import {
  UE27, estUE27, clausePerimetre, libellePerimetre, centroides, barycentre, couronne,
} from "../webapp/js/geo.js";
// Importé depuis sql.js et non db.js : ce dernier tire DuckDB-WASM, qui ne se
// résout pas hors navigateur. db.js les ré-exporte pour les modules de vues.
import { sqlStr, clauseCodes, caseCodes } from "../webapp/js/sql.js";

// --- Périmètres -----------------------------------------------------------

test("UE27 contient bien 27 pays, sans doublon", () => {
  assert.equal(UE27.length, 27);
  assert.equal(new Set(UE27).size, 27);
});

test("estUE27 distingue membres et non-membres", () => {
  assert.ok(estUE27("FRA"));
  assert.ok(estUE27("DEU"));
  assert.ok(!estUE27("GBR"), "le Royaume-Uni n'est plus membre");
  assert.ok(!estUE27("CHE"));
  assert.ok(!estUE27("XXX"));
});

test("clausePerimetre géographique s'appuie sur la colonne continent", () => {
  assert.equal(clausePerimetre("geo", "iso", "cont", true), "cont = 'Europe'");
  assert.equal(clausePerimetre("geo", "iso", "cont", false), "cont IS DISTINCT FROM 'Europe'");
});

test("clausePerimetre ue27 bascule entre IN et NOT IN", () => {
  assert.ok(clausePerimetre("ue27", "iso", "cont", true).startsWith("iso IN ("));
  assert.ok(clausePerimetre("ue27", "iso", "cont", false).startsWith("iso NOT IN ("));
});

test("la négation du périmètre géographique utilise IS DISTINCT FROM, pas <>", () => {
  // Avec `<>`, une ligne dont le continent est NULL serait exclue des deux
  // côtés du filtre et disparaîtrait silencieusement des totaux.
  const dehors = clausePerimetre("geo", "iso", "cont", false);
  assert.ok(dehors.includes("IS DISTINCT FROM"));
  assert.ok(!dehors.includes("<>"));
});

test("libellePerimetre renvoie un libellé pour chaque valeur", () => {
  assert.equal(libellePerimetre("geo"), "Europe géographique");
  assert.equal(libellePerimetre("ue27"), "UE27");
  assert.equal(libellePerimetre(undefined), "UE27", "valeur par défaut");
});

// --- Échappement SQL ------------------------------------------------------

test("sqlStr double les apostrophes pour neutraliser une injection", () => {
  assert.equal(sqlStr("abc"), "'abc'");
  assert.equal(sqlStr("O'Brien"), "'O''Brien'");
  assert.equal(sqlStr("'; DROP TABLE items; --"), "'''; DROP TABLE items; --'");
});

test("sqlStr encadre toujours la valeur, y compris les nombres", () => {
  assert.equal(sqlStr(42), "'42'");
  assert.equal(sqlStr(""), "''");
});

test("clauseCodes renvoie FALSE sur une sélection vide plutôt que tout sélectionner", () => {
  // Une clause vide élargirait silencieusement la requête à l'ensemble du jeu
  // de données : le contrat est de renvoyer un résultat vide, affiché comme tel.
  assert.equal(clauseCodes([]), "FALSE");
  assert.equal(clauseCodes(null), "FALSE");
  assert.equal(clauseCodes(undefined), "FALSE");
});

test("clauseCodes échappe chaque code", () => {
  assert.equal(clauseCodes(["2603", "7403"]), "cmdCode IN ('2603','7403')");
  assert.ok(clauseCodes(["a'b"]).includes("'a''b'"));
});

test("caseCodes ignore les groupes vides et renvoie NULL si tout est vide", () => {
  assert.equal(caseCodes({}), "NULL");
  assert.equal(caseCodes({ cuivre: [] }), "NULL");
  const expr = caseCodes({ cuivre: ["2603"], vide: [] });
  assert.ok(expr.startsWith("CASE "));
  assert.ok(expr.includes("'cuivre'"));
  assert.ok(!expr.includes("vide"), "un groupe sans code ne produit pas de branche");
});

// --- Géométrie ------------------------------------------------------------

test("centroides extrait un centre par entité, en acceptant Polygon et MultiPolygon", () => {
  const geojson = {
    features: [
      {
        id: "AAA",
        geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] },
      },
      {
        id: "BBB",
        geometry: {
          type: "MultiPolygon",
          coordinates: [[[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]]],
        },
      },
    ],
  };
  const c = centroides(geojson);
  assert.ok(c.AAA, "le polygone simple produit un centre");
  assert.ok(c.BBB, "le multipolygone produit un centre");
});

test("centroides ignore les entités sans identifiant ou sans géométrie", () => {
  const c = centroides({
    features: [
      { geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      { id: "CCC", geometry: null },
    ],
  });
  assert.equal(Object.keys(c).length, 0);
});

test("centroides accepte un GeoJSON sans features sans lever d'exception", () => {
  assert.deepEqual(centroides({}), {});
});

test("barycentre renvoie null quand aucun pays n'est connu", () => {
  assert.equal(barycentre(["ZZZ"], {}), null);
  assert.equal(barycentre([], { FRA: [2, 47] }), null);
});

test("barycentre d'un point unique redonne ce point", () => {
  const b = barycentre(["FRA"], { FRA: [2, 47] });
  assert.ok(Math.abs(b.lon - 2) < 1e-9);
  assert.ok(Math.abs(b.lat - 47) < 1e-9);
});

test("barycentre moyenne sur la sphère et non sur les degrés", () => {
  // Deux points de part et d'autre de l'antiméridien : une moyenne
  // arithmétique des longitudes donnerait 0° (au milieu de l'Atlantique),
  // la moyenne sphérique donne bien ±180°.
  const b = barycentre(["A", "B"], { A: [179, 0], B: [-179, 0] });
  assert.ok(Math.abs(Math.abs(b.lon) - 180) < 1e-6, `lon attendue ±180, obtenue ${b.lon}`);
  assert.ok(Math.abs(b.lat) < 1e-6);
});

test("couronne place le nombre de points demandé", () => {
  const pts = couronne(5, { cx: 0, cy: 0, rx: 10, ry: 10 });
  assert.equal(pts.length, 5);
  for (const [x, y] of pts) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y));
  }
});

test("couronne avec un seul point ne divise pas par zéro", () => {
  // Le cas n=1 est traité à part : la formule générale diviserait par (n-1).
  const pts = couronne(1, { cx: 0, cy: 0, rx: 10, ry: 10 });
  assert.equal(pts.length, 1);
  assert.ok(Number.isFinite(pts[0][0]) && Number.isFinite(pts[0][1]));
});
