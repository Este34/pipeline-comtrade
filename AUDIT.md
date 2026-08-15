# AUDIT — pipeline-comtrade

**Dernière mise à jour** : 15 août 2026, après application des correctifs.
Ce fichier n'est plus un diagnostic : c'est **ce qu'il faut savoir avant de modifier ce dépôt**.

## Avant de pousser

```bash
python -m ruff check .          # lint Python (le formatage n'est PAS imposé, voir plus bas)
npm test                        # 32 tests — et non `node --test tests/`, voir plus bas
find webapp/js banc -name '*.js' ! -name '*.min.js' -exec node --check {} \;
```

Ces trois commandes sont exactement ce que lance la CI (`.github/workflows/ci.yml`).

---

## Points de vigilance

### 1. Toute donnée injectée dans `innerHTML` doit passer par `esc()`

C'est la règle qui a coûté le plus cher ici : un XSS s'était glissé dans
`views/produit.js` alors que le module voisin faisait la même chose correctement.

`esc()` vit dans [webapp/js/format.js](webapp/js/format.js) et s'importe dans tout module de vue.
La règle est mécanique, donc vérifiable :

```bash
# Doit ne remonter que des nombres, ou du HTML volontairement construit par le code.
grep -rnE '(innerHTML\s*=|insertAdjacentHTML)' webapp/js/ | grep '\$\{' | grep -v 'esc('
```

**Exception légitime, à ne pas « corriger »** : `views/flux-sankey.js:390` injecte
`notes[s.id]`, qui contient des balises `<b>` voulues. L'échapper casserait le rendu.

### 2. `npm test`, jamais `node --test tests/`

`node --test` avec un **répertoire** en argument cherche un module nommé `tests` et échoue.
Le script du `package.json` passe le motif de fichiers ; c'est la seule définition, la CI
l'utilise.

### 3. Le `package.json` ne doit jamais gagner de dépendance

Il existe pour une seule raison : que Node reconnaisse les modules ES et puisse lancer les
tests. Le projet reste du **JS vanilla sans bundler**. Le déploiement Vercel n'est pas affecté
parce que `vercel.json` fixe explicitement `installCommand`, `buildCommand` et `outputDirectory`
— si l'un des trois disparaissait, l'ajout d'un `package.json` changerait le comportement du
build.

### 4. `ruff format` n'est pas imposé, et c'est délibéré

L'appliquer en bloc réécrit ~1600 lignes, dont l'intégralité de `scraper/config.py`. La CI ne
vérifie que `ruff check`. Si tu formates un fichier, fais-le dans un commit séparé pour que le
diff reste relisible.

`ruff.toml` déclare `config`, `reference_data` et `enrich` en `known-first-party` : ce sont des
modules **locaux** chargés via `sys.path.insert`, pas des paquets tiers. Sans cette déclaration,
ruff réordonne les imports et casse le regroupement voulu.

### 5. `sql.js` est séparé de `db.js` pour rester testable

`db.js` importe DuckDB-WASM, qui ne se résout pas sous Node. Les trois helpers SQL purs
(`sqlStr`, `clauseCodes`, `caseCodes`) vivent donc dans [webapp/js/sql.js](webapp/js/sql.js), et
`db.js` les ré-exporte. **Les modules de vues continuent d'importer depuis `db.js`** — ne pas
« corriger » ces imports.

Si tu ajoutes un helper SQL pur, mets-le dans `sql.js` pour qu'il soit testable.

### 6. `clauseCodes([])` renvoie `FALSE`, pas une clause vide

Une clause vide élargirait silencieusement la requête à tout le jeu de données. Le contrat est
de renvoyer un résultat vide, affiché comme tel. Un test verrouille ce comportement.

### 7. La négation de périmètre utilise `IS DISTINCT FROM`, pas `<>`

Avec `<>`, une ligne dont le continent est `NULL` serait exclue des **deux** côtés du filtre et
disparaîtrait des totaux sans trace. Un test verrouille ce comportement.

---

## Ce qui reste ouvert

| Priorité | Sujet | Note |
|---|---|---|
| Moyenne | `webapp/js/globe.js` (1214 l.) et `views/flux-sankey.js` (1161 l.) | Découpage écarté d'un commun accord : demande une validation en navigateur. Le filet de test existe désormais côté fonctions pures ; le rendu WebGL, lui, n'est pas couvert. |
| Basse | Couverture des vues | Les 32 tests portent sur `format.js`, `geo.js` et `sql.js`. Les modules de vues (requêtes + DOM) ne sont pas couverts. |
| Basse | `bulles.js:228` — placement quadratique | Sans conséquence tant que `NB_BULLES_MONDE` plafonne le nombre de nœuds. À revoir au-delà de ~500 : partitionnement spatial. |

---

## Ce qui a été corrigé (15 août 2026)

- **XSS** : `views/produit.js:51` (saisie utilisateur), les trois `e.message`, plus le titre de
  carte et les libellés de légende de `flux-sankey.js`.
- **Outillage** : `ruff.toml`, CI en trois jobs, 32 tests.
- **Lint** : 4 corrections réelles (modes `"r"` redondants).

### Rectification

L'audit initial annonçait **179 occurrences** de sinks `innerHTML`. Le chiffre brut donnait une
image fausse : après traçage de chaque occurrence jusqu'à sa source de données, **4 seulement
étaient de vrais défauts**. Le reste est du vidage de conteneur, du gabarit statique, ou de
l'interpolation déjà protégée. Ne pas se fier au compte brut d'un futur scan.
