// Tests des helpers de formatage et d'échappement.
// Lancer : node --test tests/
import test from "node:test";
import assert from "node:assert/strict";

import {
  fmtNum, fmtUSD, fmtTonnes, fmtMetric, pct, esc,
} from "../webapp/js/format.js";

test("esc neutralise les caractères qui ouvrent une balise ou un attribut", () => {
  assert.equal(esc("<script>"), "&lt;script&gt;");
  assert.equal(esc('" onerror="alert(1)'), "&quot; onerror=&quot;alert(1)");
  assert.equal(esc("a & b"), "a &amp; b");
});

test("esc échappe l'esperluette avant les chevrons, sans double échappement", () => {
  // Si l'ordre des remplacements était inversé, "&lt;" produit par le premier
  // passage serait ré-échappé en "&amp;lt;" et la sortie deviendrait fausse.
  assert.equal(esc("<"), "&lt;");
  assert.equal(esc("&lt;"), "&amp;lt;");
});

test("esc traite null et undefined comme une chaîne vide", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
});

test("esc neutralise une charge utile XSS complète", () => {
  const charge = '<img src=x onerror="alert(document.cookie)">';
  const sortie = esc(charge);
  assert.ok(!sortie.includes("<"), "aucun chevron ouvrant ne subsiste");
  assert.ok(!sortie.includes(">"), "aucun chevron fermant ne subsiste");
  assert.ok(!sortie.includes('"'), "aucun guillemet ne subsiste");
});

test("fmtNum affiche « n.d. » plutôt que NaN", () => {
  assert.equal(fmtNum(null), "n.d.");
  assert.equal(fmtNum(undefined), "n.d.");
  assert.equal(fmtNum(NaN), "n.d.");
});

test("fmtNum arrondit à l'entier", () => {
  assert.equal(fmtNum(1234.6), fmtNum(1235));
  assert.equal(fmtNum(0), "0");
});

test("fmtUSD bascule d'échelle aux bons seuils", () => {
  assert.match(fmtUSD(1.5e9), /Md \$$/);
  assert.match(fmtUSD(1.5e6), /M \$$/);
  assert.match(fmtUSD(1.5e3), /k \$$/);
  assert.match(fmtUSD(999), /\$$/);
});

test("fmtUSD garde l'échelle sur les valeurs négatives", () => {
  // Le seuil est calculé sur la valeur absolue : un solde commercial négatif
  // doit rester lisible en milliards, pas retomber en dollars bruts.
  assert.match(fmtUSD(-1.5e9), /Md \$$/);
  assert.ok(fmtUSD(-1.5e9).startsWith("-"));
});

test("fmtTonnes distingue un poids nul d'un poids absent", () => {
  // Le commerce réel a un poids non nul : zéro signifie « non rapporté ».
  assert.equal(fmtTonnes(0), "poids non déclaré");
  assert.equal(fmtTonnes(null), "poids non déclaré");
  assert.equal(fmtTonnes(-5), "poids non déclaré");
});

test("fmtTonnes convertit les kg vers l'échelle lisible", () => {
  // L'entrée est en kg, les seuils portent sur les tonnes : 1e9 kg = 1e6 t = 1 Mt.
  assert.match(fmtTonnes(1e12), /Mt$/); // 1e9 t
  assert.match(fmtTonnes(1e7), /kt$/); // 1e4 t
  assert.match(fmtTonnes(1e4), / t$/); // 10 t
  assert.match(fmtTonnes(500), /kg$/); // 0,5 t → sous le seuil, affiché en kg
});

test("fmtMetric aiguille vers le bon formateur", () => {
  assert.equal(fmtMetric(1e9, "poids"), fmtTonnes(1e9));
  assert.equal(fmtMetric(1e9, "valeur"), fmtUSD(1e9));
  assert.equal(fmtMetric(1e9, undefined), fmtUSD(1e9));
});

test("pct renvoie « n.d. » sur un total nul au lieu de diviser par zéro", () => {
  assert.equal(pct(5, 0), "n.d.");
  assert.equal(pct(5, null), "n.d.");
  assert.equal(pct(5, undefined), "n.d.");
});

test("pct formate avec la virgule décimale française", () => {
  assert.equal(pct(1, 3), "33,3 %");
  assert.equal(pct(1, 2), "50,0 %");
});
