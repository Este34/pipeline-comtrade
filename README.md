# Pipeline Comtrade

Pipeline en 3 phases sur le commerce international :

1. **Extraction massive** depuis l'API UN Comtrade, *fait*
2. **Nettoyage + export Parquet**, *fait*
3. **Webapp d'analyse 100% offline** (DuckDB-WASM), *fait*

## Périmètre d'extraction

- Type : marchandises (`C`), fréquence annuelle (`A`), classification HS
- Flux : imports + exports (`M,X`)
- Produits : chapitres HS 2 chiffres (97 chapitres) + agrégat `TOTAL`
  (paramètre `HS_LEVEL` dans `scraper/config.py` pour passer à 4 chiffres plus tard)
- Reporters : tous les pays (liste dynamique via l'API de référence)
- Partenaires : tous
- Années : 2000 → 2025 (paramétrable via `ANNEE_DEBUT` / `ANNEE_FIN`)

Tous ces paramètres sont centralisés dans `scraper/config.py`.

## Installation

```bash
python -m venv venv
venv\Scripts\activate        # Windows
pip install -r requirements.txt
```

Copier `.env.example` en `.env` et renseigner ta clé API UN Comtrade :

```
COMTRADE_API_KEY=ta_cle_ici
```

## Utilisation

### 1. Extraction (`scraper/fetch_all.py`)

```bash
# Valider le pipeline sur un seul couple (France x 2023)
python scraper/fetch_all.py --test

# Restreindre à certains pays / années
python scraper/fetch_all.py --reporters FRA,DEU --years 2020-2023

# Lancement complet (demande confirmation avec estimation du nb d'appels)
python scraper/fetch_all.py --full

# Retenter uniquement les échecs enregistrés dans failed.json
python scraper/fetch_all.py --retry-failed
```

L'API étant payante, le script ne re-télécharge **jamais** un couple
(reporter, année) déjà présent dans `data/raw/` ou déjà marqué comme traité
dans `data/checkpoints/progress.json`. En cas d'interruption (Ctrl+C), la
reprise se fait automatiquement au prochain lancement.

- `data/checkpoints/progress.json` : couples traités avec succès (`ok` ou `empty`)
- `data/checkpoints/failed.json` : échecs définitifs (après 5 tentatives avec
  backoff exponentiel), à retenter avec `--retry-failed`
- `scraper.log` : log détaillé horodaté de chaque appel

### 2. Chargement dans DuckDB (`scraper/load_to_db.py`)

```bash
python scraper/load_to_db.py
```

Charge tous les fichiers CSV de `data/raw/` non encore chargés dans
`data/comtrade.duckdb` (table `trade_records`), de façon idempotente. Affiche
un résumé (nb de lignes, plage d'années, reporters distincts, taille du
fichier, % de nulls par colonne).

## Phase 2, nettoyage + export Parquet (`clean/clean_export.py`)

```bash
python clean/clean_export.py
```

Depuis `data/comtrade.duckdb`, produit un jeu de données Parquet propre, enrichi
et partitionné, prêt pour la webapp offline DuckDB-WASM (Phase 3). Export 100 %
natif DuckDB. Résultat typique : ~4,2 Go de base → ~240 Mo de Parquet.

- `data/parquet/detail/period=YYYY/data.parquet` : détail complet (~36 M lignes),
  partitionné par année pour des lectures partielles en navigateur
- `data/parquet/aggregat/data.parquet` : lignes agrégées (partenaire *World* ou
  produit `TOTAL`), pour des dashboards macro instantanés
- `data/parquet/reference/*.parquet` : reporters, hs_codes, flows, continents
- `data/parquet/critical_agg/data.parquet` : pré-agrégat du jeu critique (voir
  « Pourquoi un pré-agrégat »), produit par `clean_export.py --critical`

Chaque ligne de détail est enrichie de `reporterISO3`, `reporterContinent`,
`partnerISO3`, `partnerContinent` (ISO3 depuis les références Comtrade, continent
via `pycountry-convert` ; les codes spéciaux, World, zones *nes*, groupes, ont
un continent nul, ce qui est attendu).

## Minéraux critiques (dataset HS6 dédié)

En complément des chapitres HS2, un dataset **HS6** cible 207 codes de minéraux
critiques et métaux de base (lithium, cobalt, terres rares, cuivre, aluminium,
zinc, graphite, tungstène…), défini dans
`scraper/config.py → CRITICAL_MINERALS_HS6`.

```bash
python scraper/fetch_all.py --critical     # extraction (tous pays, 2000-2025)
python scraper/load_to_db.py --critical     # -> table trade_critical
python clean/clean_export.py --critical      # -> data/parquet/critical/ + critical_agg/
```

L'export produit deux jeux : le **détail bilatéral** partitionné par année, et un
**pré-agrégat** (`critical_agg/data.parquet`, fichier unique) contenant une ligne
par année, déclarant, code HS6 et flux, pour le partenaire *World*. Voir
« Pourquoi un pré-agrégat » plus bas.

### Compléter le dataset sans tout re-télécharger

`fetch_all.py --critical` boucle sur (déclarant, année) et saute tout couple
déjà traité : ajouter des codes HS6 à la config l'obligerait à effacer les
checkpoints et à relancer les ~4300 appels. Or l'API accepte d'omettre le
déclarant et renvoie alors tous les pays d'un coup.

```bash
python scraper/fetch_complement.py --dry-run   # liste ce qui manque, sans appeler
python scraper/fetch_complement.py             # extraction (confirmation demandée)
```

Le script compare la config à la table déjà chargée et n'extrait que la
différence, en un appel par (année, flux), soit **52 appels au lieu de ~4300**.
Mesuré : 165 déclarants et 244 partenaires en une réponse.

Le découpage par flux n'est pas cosmétique. Un appel de contrôle tous flux
confondus atteignait **84 % du plafond de 250 000 lignes** ; séparer imports et
exports ramène la plus grosse réponse à 44 %. Le script échoue bruyamment si une
réponse frôle malgré tout le plafond, plutôt que de laisser passer des données
tronquées sans le signaler. Il filtre aussi sur la même liste de déclarants que
l'extraction principale, sinon les groupes agrégés (UE, ASEAN) entreraient dans
le complément et fausseraient les totaux par rapport aux minéraux déjà extraits.

### Taxonomie des matières : quatre stades, et une forme par code

Les trois catégories initiales (« Matière première » / « Alliage / demi-produit »
/ « Produit fini ») mélangeaient des étapes industrielles distinctes. « Matière
première » réunissait le minerai sorti du sol et l'oxyde issu d'une usine
chimique ; « Alliage / demi-produit » réunissait le métal brut sortant du
raffinage et la tôle laminée — et personne ne comprenait ce que le libellé
désignait. Le pays qui extrait est rarement celui qui raffine : confondre les
deux revient à effacer la question qu'on vient poser à ces données.

`scraper/config.py → STADES` définit donc quatre stades, du sol au produit
manufacturé :

| id | libellé | contenu |
|---|---|---|
| `extraction` | Extraction — minerai & concentré | minerais, concentrés, résidus valorisés |
| `raffinage` | Raffinage — oxydes, sels & métal brut | oxydes, sels, mattes, métal non ouvré |
| `transformation` | Transformation — alliages & demi-produits | ferro-alliages, barres, tôles, fils, poudres, déchets |
| `fini` | Produit fini | batteries, aimants, catalyseurs, cellules PV, câbles |

Chaque code HS6 porte en plus une **forme** (`minerai`, `concentré`, `cendre &
résidu`, `oxyde & hydroxyde`, `sel & composé chimique`, `métal brut`, `alliage`,
`poudre`, `demi-produit ouvré`, `déchet & débris`, `pigment`, `produit fini`,
`matière raffinée`) et un **libellé FR**. La forme est ce qui distingue une
origine primaire d'une origine secondaire — un flux de déchets de cuivre n'est
pas un flux de minerai, alors que les deux relèvent du même minéral.

### Ajouter, retirer ou reclasser un minéral

La taxonomie est **découplée des Parquet**. `clean_export.py` écrit bien des
colonnes `mineral` et `categorie` dans `data/parquet/critical/`, mais la webapp
**ne les lit plus** : elle part de `webapp/data/reference/materiaux_fr.json`,
convertit la sélection en liste de codes HS6, et filtre sur `cmdCode`.

Ce détour n'est pas gratuit, il résout un blocage précis. Les Parquet pèsent
~290 Mo, sont exclus de git et publiés en release GitHub. Tant que la taxonomie y
était figée, renommer un maillon ou reclasser un code imposait de tout
ré-exporter depuis `data/comtrade.duckdb`, puis de republier l'archive — et
cassait l'application pour quiconque avait encore l'ancien jeu.

```bash
# 1. éditer scraper/config.py -> _MATIERES (stade, forme, libellé, codes)
python clean/labels_fr.py     # régénère webapp/data/reference/materiaux_fr.json (~47 Ko)
```

C'est tout : ni ré-export, ni redéploiement des données. **La limite à connaître**
est ailleurs : reclasser ou retirer un code déjà extrait est immédiat, mais
*ajouter* un minéral absent du jeu de données demande une extraction
(`fetch_complement.py`), l'API étant payante. Un code ajouté à la config sans
extraction apparaîtra dans le référentiel avec zéro flux.

### Pourquoi un pré-agrégat, et non des requêtes à l'API

La webapp **interroge déjà** ses données en SQL : DuckDB-WASM lit les Parquet par
*range requests* HTTP, rien n'est chargé intégralement en mémoire. La lenteur
observée sur certains graphes ne venait donc pas du « tout stocké », mais de
requêtes qui lisaient beaucoup plus de données qu'elles n'en exploitaient.

Passer à des appels directs à l'API Comtrade au moment de l'affichage aurait
aggravé les choses : l'API est **payante**, sa latence mesurée est de **4 à 70 s
par appel**, elle plafonne à 250 000 lignes par réponse, et un classement mondial
demande tous les déclarants d'un coup. Surtout, cela supprimerait le
fonctionnement hors-ligne, qui est la raison d'être de la Phase 3.

Le levier était donc de **lire moins**, à résultat identique :

- La vue « Minéraux critiques » trace une carte animée et une évolution sur
  26 années à partir des seules lignes du partenaire *World*. Elle ouvrait pour
  cela les 26 partitions du détail bilatéral. Le pré-agrégat `critical_agg/`
  contient exactement ces lignes : **un aller-retour réseau au lieu de 26**.
- Trois requêtes du jeu principal (séries de « Cartes & séries », évolution de
  « Analyse par produit », série bilatérale) portaient sur `partnerCode = '0'` ou
  `cmdCode = 'TOTAL'` en balayant les 26 partitions du détail — alors que ces
  lignes sont, par définition, celles de `aggregat/`. Elles y ont été
  rebasculées ; l'égalité des résultats a été vérifiée requête par requête.
- Les requêtes indépendantes d'une même vue sont lancées **en parallèle**, et les
  résultats sont **mémoïsés par SQL** dans `webapp/js/db.js` : revenir sur un
  onglet ou rejouer une analyse identique ne relance plus rien.

Un piège à connaître si vous rebasculez d'autres requêtes du détail vers
l'agrégat : le détail porte l'année dans son **chemin de partition**, l'agrégat
non. Une requête qui s'appuyait sur `srcDetail([an])` doit gagner un
`period = <an>` explicite, sinon elle cumule silencieusement toute la période.

### Fiabilité du poids déclaré (`netWgt`)

Le tonnage vient des déclarations douanières et n'est pas toujours cohérent avec
la valeur. Contrôle fait sur le dataset critique, en comparant chaque
(déclarant, code, année) au **prix implicite médian du même code la même année**,
seule référence valable : un seuil absolu classerait comme aberrante la bauxite
australienne à 30 USD/t ou le minerai de nickel philippin à 27 USD/t, qui sont
leurs vrais prix.

Résultat : **49 cas sur 8224 (0,6 %)**. Le principal est la Papouasie-Nouvelle-Guinée
sur le minerai de cuivre (`260300`), qui déclare 41,6 Mt pour 0,5 Md USD en 2023,
soit 11 USD/t contre une médiane de 2006 chez ses pairs, et récidive de 2004 à
2022. Isolé, ce seul cas pèse 10 % du tonnage mondial 2023 et place la PNG en tête
des exportateurs, à tort : hors PNG le classement est Pérou 10,0 Mt, Indonésie
3,0, Chili 3,0. Les données sont laissées **telles quelles**, sans correction
silencieuse ; la bascule valeur/poids permet de recouper, la valeur étant ici
cohérente.

## Phase 3, webapp d'analyse offline (`webapp/`)

Application **vanilla** (aucun framework, aucun build) à identité **DSFR**, qui
interroge les Parquet directement dans le navigateur via **DuckDB-WASM**
(vendorisé, 100 % hors-ligne). Six vues : Flux, Minéraux critiques, Profil pays,
Analyse bilatérale, Analyse par produit, Cartes & séries. Libellés en français.

Fonctionnalités clés :
- **Bascule Valeur (US$) / Poids (t)** dans chaque vue. Le poids (`netWgt`) est
  fiable au niveau HS6 (minéraux) ; au niveau HS2 agrégé, Comtrade ne le rapporte
  généralement pas → affichage « poids non déclaré ».
- **Carte interactive** (Leaflet) dans « Cartes & séries » et « Minéraux
  critiques » : curseur d'années + bouton **Play** (animation 2000→2025), survol,
  clic pays. Le **fond de carte tuilé est chargé en ligne** (habillage
  uniquement) ; **les données restent 100 % offline** (DuckDB-WASM). Sans réseau,
  les pays colorés s'affichent quand même, sans le fond.
- **Minéraux critiques** : 207 codes HS6 sur 27 minéraux, couvrant les quatre
  stades de la chaîne (voir ci-dessous), avec **filtre par stade**, **recherche
  par code HS6** et **composition du périmètre** affichée — la liste exacte des
  positions sommées, sans laquelle un total reste invérifiable. *Rappel : un
  produit fini contient le minéral sans en indiquer la teneur.*
- **Flux** : diagramme de Sankey / alluvial en SVG écrit à la main (aucune
  dépendance ajoutée), à N colonnes, sous **cinq angles** — chaîne de valeur,
  dépendance d'un pays, origine d'un matériau, comparaison de minéraux, origine
  détaillée au code HS6. Détail plus bas. La bascule poids/valeur y est
  particulièrement parlante : le nickel 2023 pèse 93 % de matière brute en
  tonnage contre une part bien moindre en valeur.
- **Panier de matières éditable** (vue Flux) : minéraux, stades et formes se
  combinent librement, la liste des formes s'ajustant aux minéraux retenus. Le
  panier affiche en permanence **le nombre de positions HS6 réellement
  sélectionnées**, et signale une combinaison impossible plutôt que de renvoyer
  un graphe vide sans explication. L'état complet est **sérialisé dans l'URL**
  (`#vue=flux&mode=comparer&min=Cuivre,Nickel&an=2023`) : une analyse se partage
  par simple copie du lien, ce qui suffit pour un site statique.
- **Recherche par code produit** (Minéraux critiques, Flux, Analyse par produit).
  La saisie accepte un **NC8** (nomenclature combinée européenne, 8 chiffres),
  un HS6 ou un HS2. Comtrade publie en HS, pas en NC : un NC8 n'existe donc pas
  tel quel dans les données, mais ses six premiers chiffres *sont* le code HS6.
  La précision atteinte suit celle de l'extraction : **HS6 exact** sur les
  minéraux critiques et les flux, **chapitre à 2 chiffres** sur le jeu principal,
  où `85076000` sélectionne le chapitre `85`.
- **Listes à choix multiples au simple clic**. Un `<select multiple>` natif
  impose Ctrl/Cmd, que personne ne devine et qui rend un clic seul destructeur
  (il efface toute la sélection). L'affichage passe donc par de vraies cases à
  cocher, doublées d'un `<select>` masqué qui reste la source de vérité : les
  vues continuent de lire `selectedOptions`, y compris quand la sélection est
  pilotée depuis la carte. Au-delà de douze entrées un filtre de recherche est
  ajouté, sans quoi on perdrait la saisie semi-automatique du select natif sur
  la liste des 240 pays.
- **Navigation** : barre de contrôle sticky en verre (logo Isec, onglets en
  pilules), **palette de commandes** (`Ctrl`/`Cmd` + `K`) pour sauter à une vue
  ou ouvrir directement le profil d'un pays, **combobox avec recherche**
  remplaçant les `<select>` à liste longue (pays, chapitres HS), **puces de
  filtres actifs** retirables, **squelettes de chargement** pendant les
  requêtes DuckDB-WASM, bouton de retour en haut de page.

### Les cinq angles de la vue Flux

Le vocabulaire est celui des douanes : on parle d'**importations** et
d'**exportations**, jamais de « fournisseurs » ni de « clients ». Un même pays
est l'un et l'autre selon le sens du flux, et les deux mots suggéraient une
relation commerciale que les statistiques ne décrivent pas.

| Angle | Lecture | Question |
|---|---|---|
| **Chaîne de valeur** | exportateurs → stade → importateurs | qui vend du brut, qui vend du transformé ? |
| **Dépendance d'un pays** | importations (origines) → pays → exportations (destinations) | de qui ce pays dépend, vers qui il réexporte ? |
| **Origine d'un matériau** | classement des pays d'origine + miroir | d'où vient réellement cette matière ? |
| **Comparer des minéraux** | origines → minéral → stade → destinations | comment se comparent plusieurs filières ? |
| **Origine détaillée (HS6)** | origines → position HS6 → stade → destinations | quel produit précis, sous quelle forme ? |

Les deux derniers angles sont des **diagrammes alluviaux à quatre colonnes** :
`webapp/js/sankey.js` accepte désormais N colonnes, les colonnes intermédiaires
étant dessinées en bandeaux porteurs de leur libellé. À trois colonnes, la
géométrie est identique au Sankey d'origine.

L'angle **Origine d'un matériau** affiche systématiquement le **miroir** des
déclarations : ce que l'importateur déclare avoir reçu, face à ce que le pays
d'origine déclare avoir expédié. Un écart durable entre les deux n'est pas du
bruit — il signale une réexportation, un transbordement, ou une déclaration
incomplète, et mérite d'être lu comme tel plutôt que moyenné.

Rappel qui vaut pour les cinq angles : les douanes classent par **produit**, pas
par teneur. Un tonnage de batteries n'est pas un tonnage de lithium, et aucune
colonne du jeu de données ne permet de le convertir.

### Piège Leaflet : vider le conteneur ne détruit pas la carte

`host.innerHTML = ""` détache le DOM mais laisse vivre l'instance Leaflet, ses
écouteurs sur `window`, ses polygones, et surtout le minuteur de l'animation
« Play », qui continue de redessiner une couche détachée indéfiniment. Chaque
relance d'analyse abandonnait ainsi une carte complète : au bout de quelques
analyses le navigateur se figeait, symptôme d'autant plus trompeur qu'une
fenêtre de navigation privée, repartant d'une session vierge, paraissait saine.

`webapp/js/map.js` tient un registre des cartes vivantes et expose
`purgerCartes()`, appelée avant chaque nouvel affichage et à chaque changement
d'onglet ; le minuteur s'arrête aussi de lui-même si son conteneur a été
détaché. Vérifié en instrumentant `setInterval` : le compte reste à 1 carte et
1 minuteur après trois relances consécutives avec animation active.

### Piège hors-ligne : l'extension parquet de DuckDB

DuckDB charge la lecture Parquet comme une extension **à la demande**, récupérée
par défaut sur `extensions.duckdb.org`. Sans correctif, l'app n'est donc pas
réellement hors-ligne dès qu'une requête `read_parquet(...)` s'exécute. Le
correctif (`custom_extension_repository` pointé vers une copie locale de
l'extension) est documenté dans `webapp/vendor/duckdb-wasm/README.md`.

### Cache de résultats et durée de vie d'une session

`webapp/js/db.js` mémorise les résultats **par SQL exact**, et mémorise la
*promesse* plutôt que la valeur : deux vues qui lancent la même requête en même
temps partagent un seul aller-retour. Une requête en échec est retirée du cache,
sinon une coupure réseau passagère se rejouerait à l'identique jusqu'à la fin de
la session.

Ce cache suppose que les Parquet **ne changent pas pendant une session**, ce qui
est vrai pour un site statique dont les données sont republiées entre deux
déploiements. Si vous ajoutez un jour un changement de source à chaud, appelez
`viderCache()`.

### Développement : cache navigateur

Le rechargement des modules ES peut être masqué par le cache du navigateur.
Pour fiabiliser l'itération, servir avec un en-tête `Cache-Control: no-store`
(sans réponses 304) ou changer de port entre deux essais. En production (site
statique), le cache est au contraire souhaitable.

### Générer les libellés FR puis lancer en local

```bash
python clean/labels_fr.py                    # webapp/data/reference/*.json (pays, chapitres, référentiel matières)
python -m http.server 8000                    # depuis la RACINE du dépôt
# puis ouvrir http://localhost:8000/webapp/
```

En développement, `webapp/data/parquet` est une **jonction** vers `data/parquet`
(voir ci-dessous). Le binaire `webapp/vendor/duckdb-wasm/duckdb-eh.wasm` (~35 Mo)
n'est pas commité : voir `webapp/vendor/duckdb-wasm/README.md` pour le récupérer.

### Déploiement sur Vercel

Le dépôt est prêt à déployer tel quel : `vercel.json` sert `webapp/` à la racine
du site. La seule étape manuelle est de publier les données une fois.

**Le problème que ça résout.** Vercel plafonne l'upload de *sources* à 100 Mo
sur le plan Hobby, or les Parquet et le moteur DuckDB-WASM pèsent ~290 Mo, et ils
sont exclus de git. Ils sont donc publiés en **asset de release GitHub**, et
`deploy/build.sh` les télécharge pendant le build : ils arrivent en *sortie* de
build, où le plafond des 100 Mo ne s'applique pas.

```bash
# 1. Fabriquer l'archive (Parquet + .wasm + extension parquet) -> dist/
python deploy/package_assets.py

# 2. La publier en release GitHub (tag = ASSETS_TAG dans deploy/build.sh)
gh release create donnees-v1 dist/webapp-assets.tar.gz --notes "Parquet Comtrade + DuckDB-WASM"

# 3. Connecter le dépôt à Vercel : aucun réglage à saisir, vercel.json fait tout.
```

**Si le dépôt est privé.** Les assets d'une release privée ne sont pas
téléchargeables en accès anonyme : le build recevrait un 404. Créer un jeton
GitHub à portée `Contents: read` sur ce dépôt, puis l'ajouter dans les réglages
Vercel du projet en variable d'environnement `GITHUB_TOKEN`. `deploy/build.sh`
détecte sa présence et bascule sur l'API GitHub authentifiée. Sans jeton, il
utilise l'URL de téléchargement publique. Rendre le dépôt public dispense
entièrement de cette étape.

Après un ré-export des données, republier l'archive puis redéployer :

```bash
python deploy/package_assets.py
gh release upload donnees-v1 dist/webapp-assets.tar.gz --clobber
```

Le build échoue explicitement (et non silencieusement) si l'archive est
absente ou incomplète. Pour publier une nouvelle version des données sans écraser
l'ancienne, créer un tag `donnees-v2` et définir la variable d'environnement
`ASSETS_TAG` dans les réglages Vercel du projet.

**Cache : ne jamais marquer ces URL `immutable`.** Les chemins servis
(`/data/parquet/aggregat/data.parquet`, `/vendor/...`) sont stables alors que
leur contenu change à chaque ré-export. Un `Cache-Control: immutable` y colle
la réponse dans le navigateur du visiteur pour un an sans aucune
revalidation : si elle a été mise en cache pendant un déploiement cassé, le
site reste cassé chez lui même une fois le correctif en ligne, et une simple
recharge n'y suffit pas. `vercel.json` utilise donc `must-revalidate` avec un
`max-age` court, ce qui laisse l'ETag renvoyer un 304 bon marché tant que le
fichier n'a pas bougé, et la nouvelle version arriver dès qu'il change.

**Note sur les en-têtes.** Les en-têtes de sécurité usuels (`nosniff`,
`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) sont posés, mais pas
de CSP : `index.html` contient une *import map* inline, qui imposerait soit
`'unsafe-inline'` (CSP sans valeur réelle), soit un hash à resynchroniser à
chaque modification. Le site étant statique, en lecture seule, sans
authentification ni saisie utilisateur, le compromis ne le justifie pas.

### Déploiement ailleurs (dossier statique)

Copier dans un dossier autonome : tout `webapp/`, en remplaçant la jonction
`webapp/data/parquet` par une **copie réelle** de `data/parquet/` (détail +
aggregat + reference + critical) et en incluant le `.wasm`. Servir en HTTP
(les hôtes statiques gèrent les *range requests* nécessaires à DuckDB-WASM).
Aucune requête vers l'API Comtrade au runtime.

Recréer la jonction de dev (Windows) si besoin :
```powershell
New-Item -ItemType Junction -Path "webapp\data\parquet" -Target "data\parquet"
```

## Structure

```
scraper/                # Phase 1, extraction
├── config.py           # Périmètre + paramètres + chemins
├── fetch_all.py        # Extraction par (reporter, année)
├── load_to_db.py        # Chargement fichiers → DuckDB
└── reference_data.py    # Listes pays / codes HS / flux
clean/                   # Phase 2/3, nettoyage + export Parquet + libellés FR
├── enrich.py           # Mapping code pays → ISO3 + continent
├── clean_export.py      # Export Parquet partitionné + enrichi (+ --critical)
└── labels_fr.py          # Libellés FR + référentiel matières (stades, formes, HS6) → JSON
deploy/                  # Déploiement Vercel
├── build.sh            # Build Vercel : récupère les données depuis la release
└── package_assets.py    # Fabrique dist/webapp-assets.tar.gz à publier
webapp/                  # Phase 3, application d'analyse offline (DSFR)
├── index.html          # Coquille + onglets
├── css/, assets/         # Styles DSFR + police Marianne
├── vendor/               # DuckDB-WASM, Chart.js, apache-arrow, fond de carte
├── js/                    # db.js (DuckDB-WASM), charts, sankey, format, labels + views/
└── data/                   # reference/*.json (FR) + parquet/ (jonction/copie)
data/
├── raw/, raw_critical/   # Réponses brutes {reporterCode}_{year}.csv
├── checkpoints/           # progress*.json, failed*.json, reporters_cache.csv
├── comtrade.duckdb         # Base locale (trade_records + trade_critical)
└── parquet/               # detail/, aggregat/, reference/, critical/, critical_agg/
```

`data/` et `.env` sont exclus de git (voir `.gitignore`) : aucune clé ni
donnée n'est commitée.
