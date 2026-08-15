# Audit — pipeline-comtrade

**Date** : 15 août 2026 · **Périmètre** : ~10 500 lignes (webapp JS vanilla + scraper Python)
**Méthode** : revue de code, scans outillés, exécution des vérifications disponibles.

## Synthèse

Le dépôt le plus exposé de l'écosystème : c'est le plus gros contributeur de lignes, il porte la
plus forte densité de manipulation du DOM, et il est le **seul avec le volume de `Site-Cvi-Vitrine`
à n'avoir ni test ni intégration continue**.

La qualité du code est pourtant bonne : la fonction d'échappement `esc()`
([webapp/js/format.js:68](webapp/js/format.js#L68)) est importée et appliquée systématiquement
dans `ui.js`, `globe.js`, `globe-choroplethe.js`, `heatmap.js`, `map.js` et `palette.js`. Le
build de déploiement est robuste (`set -euo pipefail`, vérification d'intégrité de l'archive).
Les problèmes relevés sont des **oublis ponctuels**, pas un défaut de conception.

| Sévérité | Nombre |
|---|---|
| 🔴 Critique | 1 |
| 🟠 Élevé | 2 |
| 🟡 Moyen | 3 |
| ⚪ Faible | 1 |

---

## 🔴 Critique

### C1 — XSS DOM : saisie utilisateur injectée sans échappement

**Fichier** : [webapp/js/views/produit.js:51](webapp/js/views/produit.js#L51)

```js
res.innerHTML = `<div class="empty">Aucun chapitre HS ne correspond au code « ${champCode.value} ».</div>`;
```

`champCode.value` est le contenu brut du champ de saisie `#pr-code`, injecté dans `innerHTML`
sans passer par `esc()`. Saisir `<img src=x onerror=alert(1)>` puis déclencher `appliquerCode()`
exécute le script.

**Pourquoi c'est un vrai finding et pas un faux positif** : c'est le seul endroit du dépôt où une
saisie utilisateur atteint `innerHTML` sans échappement. Le fichier voisin
[webapp/js/palette.js:61](webapp/js/palette.js#L61) fait exactement la même chose **correctement** :

```js
list.innerHTML = `<div class="palette-empty">Aucun résultat pour « ${esc(input.value)} »</div>`;
```

C'est donc un oubli isolé, pas un choix d'architecture.

**Portée réelle** : la valeur n'est ni persistée ni partagée par URL — l'exploitation se limite à
l'auto-injection (*self-XSS*), ce qui abaisse l'impact. Elle reste à corriger : le correctif est
d'un caractère, et le site n'a pas de CSP pour amortir un contournement.

**Correction** : envelopper dans `esc()`, déjà importé dans le module.
**Effort** : 1 minute.

---

## 🟠 Élevé

### E1 — Aucun test, aucune intégration continue

Aucun fichier de test, aucun `.github/workflows/`, aucun linter configuré, pour ~10 500 lignes
dont un moteur de rendu WebGL (`globe.js`, 1 214 l.) et un calcul de graphe de flux
(`views/flux-sankey.js`, 1 161 l.).

Comparaison interne : `veille-mineraux-nucleaire` fait tourner 328 tests sur un volume
comparable, et `Site-Cvi-Vitrine` a typecheck + lint + format + tests + build en CI. Ce dépôt
est le seul gros contributeur sans aucun filet.

**Conséquence concrète** : toute modification de `flux-sankey.js` ou `globe.js` est validée
uniquement à l'œil, dans le navigateur, sur les scénarios auxquels on pense.

**Correction proposée** :
1. Un workflow minimal — `ruff check` sur `scraper/` + `clean/`, `node --check` sur les modules
   webapp — rattrape déjà les erreurs de syntaxe et de style pour un coût quasi nul.
2. Des tests unitaires sur les fonctions pures extractibles : `geo.js` (calculs d'anneaux et
   d'aires), `format.js`, la construction du graphe dans `sankey.js`.

**Effort** : 1 h pour le workflow, 1 j pour un premier socle de tests.

### E2 — Messages d'exception injectés dans le DOM sans échappement

**Fichiers** :
- [webapp/js/views/europe.js:669](webapp/js/views/europe.js#L669)
- [webapp/js/views/flux-sankey.js:1073](webapp/js/views/flux-sankey.js#L1073)
- [webapp/js/main.js:51](webapp/js/main.js#L51)

```js
hote.innerHTML = `<div class="empty">Cette échelle n'a pas pu être calculée : ${e.message}</div>`;
```

`e.message` provient de DuckDB-WASM, du parsing Parquet ou de `fetch`. Ces messages contiennent
souvent des fragments de la requête SQL ou du nom de fichier concerné, donc indirectement des
données. Le risque d'exécution est faible, mais la règle « aucune interpolation non échappée
dans `innerHTML` » a l'avantage d'être vérifiable mécaniquement, contrairement à un raisonnement
au cas par cas sur l'origine de chaque message.

**Correction** : `esc(e.message)`, ou `textContent` sur un nœud dédié.
**Effort** : 15 minutes pour les trois.

---

## 🟡 Moyen

### M1 — Deux fichiers dépassent 1 000 lignes, avec des fonctions de plus de 100 lignes

| Fichier | Lignes | Plus longue fonction |
|---|---|---|
| `webapp/js/globe.js` | 1 214 | 217 l. (à partir de la l. 638) |
| `webapp/js/views/flux-sankey.js` | 1 161 | 135 l. (`rendreOrigine`, l. 757) |
| `webapp/js/views/europe.js` | 728 | 132 l. (`rendreIntra`, l. 527) |

C'est le point qui répond directement à la question « le code est-il encore modifiable ? ».
Une fonction de 217 lignes qui mêle projection géographique, construction de géométrie three.js
et gestion d'événements ne peut pas être modifiée sans relire l'intégralité de son corps.

**Ce n'est pas une demande de refonte.** La découpe a un coût et un risque de régression réels,
sans test pour les couvrir (cf. E1). L'ordre recommandé est donc : **E1 d'abord** (le filet),
**M1 ensuite** (la découpe) — jamais l'inverse.

### M2 — Boucle de collision quadratique dans le placement des bulles

**Fichier** : [webapp/js/bulles.js:228-229](webapp/js/bulles.js#L228)

```js
for (let i = 0; i < noeuds.length; i++) {
  for (let j = i + 1; j < noeuds.length; j++) {
```

Quadratique en nombre de bulles. C'est le schéma normal d'un placement par répulsion, et le
nombre de bulles est plafonné (`NB_BULLES_MONDE`) — **ce n'est donc pas un défaut aujourd'hui**.
À surveiller uniquement si ce plafond est relevé : au-delà de ~500 nœuds, un partitionnement
spatial (grille ou quadtree) devient nécessaire.

Signalé pour traçabilité, pas pour correction immédiate.

### M3 — Le code Python n'est ni linté ni formaté

`ruff check .` remonte des corrections automatiques sur `scraper/` et `clean/` (15 corrigeables
automatiquement), alors qu'aucune configuration `ruff.toml` n'existe dans le dépôt.

Les dépôts `veille-mineraux-nucleaire` et `Simulateur-Holistica-Régionale` ont déjà un
`ruff.toml` : le fichier peut être repris tel quel.

**Effort** : 30 minutes (copie de la config + `ruff check --fix` + relecture du diff).

---

## ⚪ Faible

### F1 — `banc/index.html` contient des sinks DOM hors du périmètre audité

Le répertoire `banc/` est un banc d'essai non déployé (`outputDirectory` vaut `webapp`). Ses
usages de `innerHTML` ne sont pas exposés en production. Aucune action requise ; noté pour que
le fichier ne remonte pas comme faux positif lors d'un futur scan automatisé.

---

## Points positifs relevés

Ils comptent autant que les défauts, et méritent d'être préservés :

- **`deploy/build.sh`** — `set -euo pipefail`, `curl --retry`, et une vérification explicite que
  l'archive extraite est complète, avec un commentaire qui explique *pourquoi* le garde-fou
  existe (« sans ce garde-fou, un build qui réussit avec une archive incomplète produirait un
  site cassé seulement à l'exécution »). C'est le bon réflexe.
- **`vercel.json`** — `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy` et un `Cache-Control` calibré sur les Parquet. Meilleure posture
  d'en-têtes des sept dépôts.
- **Chargement paresseux du globe** — `flux-sankey.js:530` ne construit la carte qu'à la première
  ouverture du `<details>`, avec un commentaire qui justifie la décision par le coût d'un
  contexte WebGL et les 185 Ko de three.js. Optimisation juste, et documentée.
- **`esc()` appliqué presque partout** — 6 modules l'importent et l'utilisent correctement.
- **Accessibilité** — `lang="fr"`, 83 attributs `aria-*`, aucun gestionnaire de clic sur élément
  non focusable, aucune image sans `alt`.

---

## Checklist de remédiation

- [ ] **C1** — `esc(champCode.value)` dans `views/produit.js:51`
- [ ] **E2** — `esc(e.message)` dans `europe.js:669`, `flux-sankey.js:1073`, `main.js:51`
- [ ] **E1a** — Ajouter `.github/workflows/ci.yml` (ruff sur Python, `node --check` sur webapp)
- [ ] **M3** — Copier `ruff.toml` depuis `veille-mineraux-nucleaire`, lancer `ruff check --fix`
- [ ] **E1b** — Premiers tests unitaires sur `geo.js`, `format.js`, `sankey.js`
- [ ] **M1** — Découper `globe.js` et `flux-sankey.js` **après** E1b uniquement

---

## Reproduire cet audit

```bash
# Sinks DOM avec interpolation non échappée
grep -rnE '(innerHTML\s*=|insertAdjacentHTML)' webapp/js/ | grep '\$\{' | grep -v 'esc('

# Fichiers > 500 lignes
find webapp scraper clean -name '*.js' -o -name '*.py' | xargs wc -l | sort -rn | head

# Lint Python
python -m ruff check .
```
