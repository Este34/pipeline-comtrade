"""
Configuration centrale du pipeline d'extraction UN Comtrade.
Tous les paramètres du périmètre d'extraction sont regroupés ici.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# Racine du projet (parent du dossier scraper/)
BASE_DIR = Path(__file__).resolve().parent.parent

# Chargement des variables d'environnement (.env à la racine du projet)
load_dotenv(BASE_DIR / ".env")

COMTRADE_API_KEY = os.getenv("COMTRADE_API_KEY")

# --- Périmètre d'extraction ---
TYPE_CODE = "C"  # C = commodities (marchandises)
FREQ_CODE = "A"  # A = annuel
CL_CODE = "HS"  # classification HS
FLOW_CODE = "M,X"  # imports + exports

# Niveau de détail produit (2 = chapitres HS à 2 chiffres). Changer ici pour
# passer à 4 chiffres plus tard : reference_data.get_hs_codes() s'adapte
# automatiquement à ce niveau.
HS_LEVEL = 2

ANNEE_DEBUT = 2000
ANNEE_FIN = 2025

# --- Comportement réseau ---
PAUSE_ENTRE_REQUETES = 1.5  # secondes entre deux appels d'un même worker
MAX_RETRIES = 5
BACKOFF_BASE = 2  # secondes ; backoff exponentiel 2,4,8,16,32

# Nombre d'appels API en parallèle. La latence observée par appel (4 à 70s,
# selon le volume de données du pays) domine largement PAUSE_ENTRE_REQUETES :
# c'est donc le vrai levier pour accélérer un fetch --full de plusieurs
# milliers de paires. À ajuster à la baisse si des 429 répétés apparaissent
# dans scraper.log.
N_WORKERS = 6

# --- Chemins ---
DATA_DIR = BASE_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
CHECKPOINTS_DIR = DATA_DIR / "checkpoints"
PROGRESS_FILE = CHECKPOINTS_DIR / "progress.json"
FAILED_FILE = CHECKPOINTS_DIR / "failed.json"
REPORTERS_CACHE_FILE = CHECKPOINTS_DIR / "reporters_cache.csv"
DB_PATH = DATA_DIR / "comtrade.duckdb"
LOG_PATH = BASE_DIR / "scraper.log"

# --- Phase 2 : export Parquet ---
PARQUET_DIR = DATA_DIR / "parquet"
PARQUET_DETAIL_DIR = PARQUET_DIR / "detail"
PARQUET_AGGREGAT_DIR = PARQUET_DIR / "aggregat"
PARQUET_REFERENCE_DIR = PARQUET_DIR / "reference"
PARQUET_CRITICAL_DIR = PARQUET_DIR / "critical"

# --- Phase 3 : extraction HS6 minéraux critiques (dataset dédié) ---
# Chemins séparés pour ne pas mélanger avec le run HS2 principal.
RAW_CRITICAL_DIR = DATA_DIR / "raw_critical"
PROGRESS_CRITICAL_FILE = CHECKPOINTS_DIR / "progress_critical.json"
FAILED_CRITICAL_FILE = CHECKPOINTS_DIR / "failed_critical.json"

# --- Taxonomie des matières (chaîne de valeur) ---
#
# Quatre stades, du sol au produit manufacturé. Ils remplacent les trois
# catégories précédentes ("Matière première" / "Alliage / demi-produit" /
# "Produit fini"), dont le maillon central mélangeait le métal brut sortant du
# raffinage et les demi-produits ouvrés : deux étapes industrielles distinctes,
# et deux marchés distincts. Séparer l'extraction du raffinage compte tout
# autant, parce que le pays qui sort le minerai du sol est rarement celui qui
# le raffine.
STADES = [
    {
        "id": "extraction",
        "label": "Extraction — minerai & concentré",
        "ordre": 1,
        "description": "Ce qui sort du sol : minerais, concentrés, résidus valorisés.",
    },
    {
        "id": "raffinage",
        "label": "Raffinage — oxydes, sels & métal brut",
        "ordre": 2,
        "description": "Chimie et métallurgie primaire : oxydes, sels, mattes, métal non ouvré.",
    },
    {
        "id": "transformation",
        "label": "Transformation — alliages & demi-produits",
        "ordre": 3,
        "description": "Métal ouvré : ferro-alliages, barres, tôles, fils, poudres, déchets.",
    },
    {
        "id": "fini",
        "label": "Produit fini",
        "ordre": 4,
        "description": "Produits manufacturés embarquant le minéral, teneur non déclarée.",
    },
]
STADE_LABELS = {s["id"]: s["label"] for s in STADES}

# Forme physico-chimique du produit, transversale aux stades. C'est le niveau de
# détail qui permet de distinguer une origine primaire (minerai) d'une origine
# secondaire (déchet, résidu), ce que le seul stade ne dit pas.
FORMES = {
    "minerai": "Minerai",
    "concentre": "Concentré",
    "residu": "Cendre & résidu",
    "oxyde": "Oxyde & hydroxyde",
    "sel": "Sel & composé chimique",
    "raffinee": "Matière raffinée (non métallique)",
    "pigment": "Pigment",
    "metal_brut": "Métal brut (non ouvré)",
    "alliage": "Alliage",
    "poudre": "Poudre",
    "demi_produit": "Demi-produit ouvré",
    "dechet": "Déchet & débris",
    "produit_fini": "Produit fini",
}

# Liste curée élargie de codes HS6 (tous validés dans la référence Comtrade
# 'cmd:HS'). Base : listes UE/USGS des matières premières critiques.
#
# Rappel qui vaut pour toute lecture de ces données : les statistiques
# douanières classent par PRODUIT, pas par teneur. Un produit fini « contient »
# le minéral sans que la quantité embarquée soit déclarée nulle part — un
# tonnage de batteries n'est pas un tonnage de lithium.
#
# Structure : (minéral, stade, forme, {code HS6: libellé FR}).
_MATIERES = [
    # ---------------------------------------------------------------- Lithium
    # Pas de code d'extraction : le spodumène relève du 253090 (« autres
    # matières minérales »), trop large pour être imputé au lithium.
    ("Lithium", "raffinage", "oxyde", {
        "282520": "Oxyde et hydroxyde de lithium",
    }),
    ("Lithium", "raffinage", "sel", {
        "283691": "Carbonate de lithium",
        "284530": "Lithium enrichi en lithium 6 et ses composés",
    }),
    ("Lithium", "fini", "produit_fini", {
        "850650": "Piles au lithium",
        "850760": "Accumulateurs lithium-ion",
    }),
    # ----------------------------------------------------------------- Cobalt
    ("Cobalt", "extraction", "minerai", {
        "260500": "Minerais de cobalt et leurs concentrés",
    }),
    ("Cobalt", "raffinage", "oxyde", {
        "282200": "Oxydes et hydroxydes de cobalt",
    }),
    ("Cobalt", "raffinage", "sel", {
        "282734": "Chlorure de cobalt",
    }),
    ("Cobalt", "raffinage", "metal_brut", {
        "810510": "Mattes de cobalt et produits intermédiaires, cobalt brut, poudres",
        "810520": "Mattes de cobalt et produits intermédiaires, cobalt brut, poudres",
    }),
    ("Cobalt", "transformation", "dechet", {
        "810530": "Déchets et débris de cobalt",
    }),
    ("Cobalt", "transformation", "demi_produit", {
        "810590": "Ouvrages en cobalt",
    }),
    # ------------------------------------------------------------ Terres rares
    ("Terres rares", "raffinage", "metal_brut", {
        "280530": "Métaux de terres rares, scandium et yttrium",
    }),
    ("Terres rares", "raffinage", "sel", {
        "284610": "Composés du cérium",
        "284690": "Autres composés des terres rares, d'yttrium ou de scandium",
    }),
    ("Terres rares", "transformation", "alliage", {
        "360690": "Ferrocérium et autres alliages pyrophoriques",
    }),
    ("Terres rares", "fini", "produit_fini", {
        "850511": "Aimants permanents en métal (néodyme-fer-bore dominant)",
        "850519": "Autres aimants permanents",
    }),
    # --------------------------------------------------------------- Graphite
    ("Graphite", "extraction", "minerai", {
        "250410": "Graphite naturel en poudre ou en paillettes",
        "250490": "Graphite naturel, autres formes",
    }),
    ("Graphite", "raffinage", "raffinee", {
        "380110": "Graphite artificiel",
        "380120": "Graphite colloïdal ou semi-colloïdal",
    }),
    ("Graphite", "transformation", "demi_produit", {
        "380190": "Préparations à base de graphite, pâtes et demi-produits",
    }),
    # -------------------------------------------------------------- Tungstène
    ("Tungstène", "extraction", "minerai", {
        "261100": "Minerais de tungstène et leurs concentrés",
    }),
    ("Tungstène", "raffinage", "sel", {
        "284180": "Tungstates (paratungstate d'ammonium notamment)",
    }),
    ("Tungstène", "raffinage", "poudre", {
        "810110": "Poudres de tungstène",
    }),
    ("Tungstène", "raffinage", "metal_brut", {
        "810191": "Tungstène sous forme brute, y compris barres simplement frittées",
        "810194": "Tungstène sous forme brute, y compris barres simplement frittées",
    }),
    ("Tungstène", "transformation", "alliage", {
        "720280": "Ferro-tungstène et ferro-silico-tungstène",
    }),
    ("Tungstène", "transformation", "demi_produit", {
        "810196": "Fils de tungstène",
        "810199": "Autres ouvrages en tungstène",
    }),
    ("Tungstène", "transformation", "dechet", {
        "810197": "Déchets et débris de tungstène",
    }),
    ("Tungstène", "fini", "produit_fini", {
        "853921": "Lampes halogènes à filament de tungstène",
        "853922": "Lampes à filament de 200 W ou moins",
    }),
    # ------------------------------------------- Niobium, tantale, vanadium
    ("Niobium, tantale, vanadium", "extraction", "minerai", {
        "261590": "Minerais de niobium, tantale et vanadium, et leurs concentrés",
    }),
    ("Niobium", "transformation", "alliage", {
        "720293": "Ferro-niobium",
    }),
    ("Tantale", "raffinage", "metal_brut", {
        "810310": "Tantale sous forme brute et poudres",
        "810320": "Tantale sous forme brute et poudres",
    }),
    ("Tantale", "transformation", "dechet", {
        "810330": "Déchets et débris de tantale",
    }),
    ("Tantale", "transformation", "demi_produit", {
        "810390": "Ouvrages en tantale",
        "810391": "Creusets en tantale",
        "810399": "Autres ouvrages en tantale",
    }),
    ("Tantale", "fini", "produit_fini", {
        "853221": "Condensateurs fixes au tantale",
    }),
    ("Vanadium", "extraction", "residu", {
        "262050": "Cendres et résidus contenant du vanadium (source secondaire)",
    }),
    ("Vanadium", "raffinage", "oxyde", {
        "282530": "Oxydes et hydroxydes de vanadium",
    }),
    ("Vanadium", "raffinage", "metal_brut", {
        "811240": "Vanadium sous forme brute et poudres",
    }),
    ("Vanadium", "transformation", "alliage", {
        "720292": "Ferro-vanadium",
    }),
    # ----------------------------------------------------------------- Nickel
    ("Nickel", "extraction", "minerai", {
        "260400": "Minerais de nickel et leurs concentrés",
    }),
    ("Nickel", "raffinage", "oxyde", {
        "282540": "Oxydes et hydroxydes de nickel",
    }),
    ("Nickel", "raffinage", "sel", {
        "282735": "Chlorure de nickel",
        "283324": "Sulfate de nickel",
    }),
    ("Nickel", "raffinage", "metal_brut", {
        "750110": "Mattes de nickel",
        "750120": "Sinters d'oxydes de nickel et autres produits intermédiaires",
        "750210": "Nickel brut non allié",
    }),
    ("Nickel", "raffinage", "alliage", {
        "750220": "Alliages de nickel sous forme brute",
    }),
    ("Nickel", "transformation", "dechet", {
        "750300": "Déchets et débris de nickel",
    }),
    ("Nickel", "transformation", "poudre", {
        "750400": "Poudres et paillettes de nickel",
    }),
    ("Nickel", "transformation", "demi_produit", {
        "750511": "Barres et profilés en nickel non allié",
        "750512": "Barres et profilés en alliages de nickel",
    }),
    ("Nickel", "fini", "produit_fini", {
        "381511": "Catalyseurs supportés à base de nickel",
        "381519": "Autres catalyseurs supportés",
        "850730": "Accumulateurs nickel-cadmium",
        "850750": "Accumulateurs nickel-hydrure métallique",
    }),
    # -------------------------------------------------------------- Manganèse
    ("Manganèse", "extraction", "minerai", {
        "260200": "Minerais de manganèse et leurs concentrés",
    }),
    ("Manganèse", "raffinage", "oxyde", {
        "282010": "Dioxyde de manganèse",
        "282090": "Autres oxydes de manganèse",
    }),
    ("Manganèse", "raffinage", "metal_brut", {
        "811100": "Manganèse brut, poudres, déchets et ouvrages",
    }),
    ("Manganèse", "transformation", "alliage", {
        "720211": "Ferro-manganèse à plus de 2 % de carbone",
        "720219": "Ferro-manganèse, autres teneurs en carbone",
        "720230": "Ferro-silico-manganèse",
    }),
    ("Manganèse", "fini", "produit_fini", {
        "850610": "Piles au dioxyde de manganèse",
        "850611": "Piles au dioxyde de manganèse (volume de 300 cm³ ou moins)",
    }),
    # ----------------------------------------------------------------- Titane
    ("Titane", "extraction", "minerai", {
        "261400": "Minerais de titane et leurs concentrés (ilménite, rutile)",
    }),
    ("Titane", "raffinage", "oxyde", {
        "282300": "Oxydes de titane",
    }),
    ("Titane", "raffinage", "metal_brut", {
        "810810": "Titane sous forme brute, poudres, déchets",
        "810820": "Titane sous forme brute et poudres",
    }),
    ("Titane", "transformation", "pigment", {
        "320611": "Pigments à base de dioxyde de titane, 80 % ou plus de TiO₂",
        "320619": "Autres pigments à base de dioxyde de titane",
    }),
    ("Titane", "transformation", "alliage", {
        "720291": "Ferro-titane et ferro-silico-titane",
    }),
    ("Titane", "transformation", "dechet", {
        "810830": "Déchets et débris de titane",
    }),
    ("Titane", "transformation", "demi_produit", {
        "810890": "Ouvrages en titane",
    }),
    # ----------------------------------------------------------------- Chrome
    ("Chrome", "extraction", "minerai", {
        "261000": "Minerais de chrome et leurs concentrés (chromite)",
    }),
    ("Chrome", "raffinage", "oxyde", {
        "281910": "Trioxyde de chrome",
        "281990": "Autres oxydes et hydroxydes de chrome",
    }),
    ("Chrome", "raffinage", "sel", {
        "283323": "Sulfate de chrome",
    }),
    ("Chrome", "raffinage", "metal_brut", {
        "811221": "Chrome sous forme brute et poudres",
    }),
    ("Chrome", "transformation", "alliage", {
        "720241": "Ferro-chrome à plus de 4 % de carbone",
        "720249": "Ferro-chrome, autres teneurs en carbone",
        "720250": "Ferro-silico-chrome",
    }),
    ("Chrome", "transformation", "dechet", {
        "811222": "Déchets et débris de chrome",
    }),
    ("Chrome", "transformation", "demi_produit", {
        "811229": "Ouvrages en chrome",
    }),
    # ------------------------------------------------ Platinoïdes (PGM)
    ("Platine", "raffinage", "metal_brut", {
        "711011": "Platine sous forme brute ou en poudre",
    }),
    ("Platine", "transformation", "demi_produit", {
        "711019": "Platine sous formes mi-ouvrées",
    }),
    ("Platine", "transformation", "dechet", {
        "711292": "Déchets et débris de platine",
    }),
    ("Platine", "fini", "produit_fini", {
        "711510": "Catalyseurs en toiles et treillis de platine",
    }),
    ("Palladium", "raffinage", "metal_brut", {
        "711021": "Palladium sous forme brute ou en poudre",
    }),
    ("Palladium", "transformation", "demi_produit", {
        "711029": "Palladium sous formes mi-ouvrées",
    }),
    ("Rhodium", "raffinage", "metal_brut", {
        "711031": "Rhodium sous forme brute ou en poudre",
    }),
    ("Rhodium", "transformation", "demi_produit", {
        "711039": "Rhodium sous formes mi-ouvrées",
    }),
    ("Iridium, osmium, ruthénium", "raffinage", "metal_brut", {
        "711041": "Iridium, osmium et ruthénium sous forme brute ou en poudre",
    }),
    ("Iridium, osmium, ruthénium", "transformation", "demi_produit", {
        "711049": "Iridium, osmium et ruthénium sous formes mi-ouvrées",
    }),
    # -------------------------------------------------------------- Antimoine
    ("Antimoine", "extraction", "minerai", {
        "261710": "Minerais d'antimoine et leurs concentrés",
    }),
    ("Antimoine", "raffinage", "oxyde", {
        "282580": "Oxydes d'antimoine",
    }),
    ("Antimoine", "raffinage", "metal_brut", {
        "811010": "Antimoine sous forme brute et poudres",
    }),
    ("Antimoine", "transformation", "dechet", {
        "811020": "Déchets et débris d'antimoine",
    }),
    ("Antimoine", "transformation", "demi_produit", {
        "811090": "Ouvrages en antimoine",
    }),
    # -------------------------------------------------------------- Magnésium
    ("Magnésium", "extraction", "minerai", {
        "251910": "Carbonate de magnésium naturel (magnésite)",
    }),
    ("Magnésium", "raffinage", "oxyde", {
        "251990": "Magnésie électrofondue ou calcinée, autres oxydes de magnésium",
        "281610": "Hydroxyde et peroxyde de magnésium",
    }),
    ("Magnésium", "raffinage", "sel", {
        "282731": "Chlorure de magnésium",
    }),
    ("Magnésium", "raffinage", "metal_brut", {
        "810411": "Magnésium brut titrant au moins 99,8 % de magnésium",
        "810419": "Magnésium brut, autres teneurs",
    }),
    ("Magnésium", "transformation", "dechet", {
        "810420": "Déchets et débris de magnésium",
    }),
    ("Magnésium", "transformation", "poudre", {
        "810430": "Copeaux, tournures, granulés et poudres de magnésium",
    }),
    ("Magnésium", "transformation", "demi_produit", {
        "810490": "Ouvrages en magnésium",
    }),
    # -------------------------------------------------------------- Silicium
    ("Silicium", "raffinage", "raffinee", {
        "280461": "Silicium titrant au moins 99,99 % (qualité électronique)",
        "280469": "Silicium, autres teneurs (silicium métallurgique)",
    }),
    ("Silicium", "raffinage", "oxyde", {
        "281122": "Dioxyde de silicium (silice)",
    }),
    ("Silicium", "raffinage", "sel", {
        "284920": "Carbure de silicium",
    }),
    ("Silicium", "transformation", "alliage", {
        "720221": "Ferro-silicium à plus de 55 % de silicium",
        "720229": "Ferro-silicium, autres teneurs",
    }),
    ("Silicium", "fini", "produit_fini", {
        "850171": "Générateurs photovoltaïques à courant continu, 50 W ou moins",
        "854141": "Cellules photovoltaïques non assemblées en modules",
        "854143": "Cellules photovoltaïques assemblées en modules ou panneaux",
    }),
    # ------------------------------------------- Gallium, germanium, indium
    ("Gallium, germanium, indium", "raffinage", "oxyde", {
        "282560": "Oxydes de germanium et dioxyde de zirconium",
    }),
    ("Gallium, germanium, indium", "raffinage", "metal_brut", {
        "811230": "Germanium sous forme brute, poudres et ouvrages",
        "811292": "Gallium, indium et métaux voisins sous forme brute, poudres, déchets",
    }),
    ("Gallium, germanium, indium", "transformation", "demi_produit", {
        "811299": "Ouvrages en gallium, indium et métaux voisins",
    }),
    # -------------------------------------------------------------- Béryllium
    ("Béryllium", "raffinage", "metal_brut", {
        "811211": "Béryllium sous forme brute et poudres",
    }),
    ("Béryllium", "transformation", "dechet", {
        "811212": "Déchets et débris de béryllium",
    }),
    ("Béryllium", "transformation", "demi_produit", {
        "811213": "Ouvrages en béryllium",
        "811219": "Autres ouvrages en béryllium",
    }),
    # -------------------------------------------------------------- Molybdène
    ("Molybdène", "extraction", "concentre", {
        "261310": "Minerais de molybdène grillés et leurs concentrés",
    }),
    ("Molybdène", "extraction", "minerai", {
        "261390": "Minerais de molybdène non grillés et leurs concentrés",
    }),
    ("Molybdène", "raffinage", "oxyde", {
        "282570": "Oxydes et hydroxydes de molybdène",
    }),
    ("Molybdène", "raffinage", "sel", {
        "284170": "Molybdates",
    }),
    ("Molybdène", "raffinage", "poudre", {
        "810210": "Poudres de molybdène",
    }),
    ("Molybdène", "raffinage", "metal_brut", {
        "810291": "Molybdène sous forme brute, y compris barres simplement frittées",
        "810294": "Molybdène sous forme brute, y compris barres simplement frittées",
    }),
    ("Molybdène", "transformation", "alliage", {
        "720270": "Ferro-molybdène",
    }),
    ("Molybdène", "transformation", "demi_produit", {
        "810295": "Barres, profilés, tôles et feuilles de molybdène",
        "810296": "Fils de molybdène",
        "810299": "Autres ouvrages en molybdène",
    }),
    ("Molybdène", "transformation", "dechet", {
        "810297": "Déchets et débris de molybdène",
    }),
    # --------------------------------------------------------------- Bismuth
    ("Bismuth", "raffinage", "sel", {
        "283422": "Nitrates de bismuth",
        "283693": "Carbonate de bismuth",
    }),
    ("Bismuth", "raffinage", "metal_brut", {
        "810600": "Bismuth sous forme brute, déchets et ouvrages",
        "810610": "Bismuth titrant au moins 99,99 % et ouvrages",
    }),
    ("Bismuth", "transformation", "demi_produit", {
        "810690": "Autres formes de bismuth et ouvrages",
    }),
    # Métaux de base à fort enjeu d'approvisionnement. Ils ne figurent pas sur la
    # liste UE des matières premières « critiques » (le cuivre y est « stratégique »
    # depuis le CRMA 2023, le zinc n'y est pas), mais ils structurent l'électrification
    # et la construction, ce qui les rend indispensables à une lecture des ressources.
    # ----------------------------------------------------------------- Cuivre
    ("Cuivre", "extraction", "minerai", {
        "260300": "Minerais de cuivre et leurs concentrés",
    }),
    ("Cuivre", "raffinage", "oxyde", {
        "282550": "Oxydes et hydroxydes de cuivre",
    }),
    ("Cuivre", "raffinage", "sel", {
        "283325": "Sulfate de cuivre",
    }),
    ("Cuivre", "raffinage", "metal_brut", {
        "740100": "Mattes de cuivre, cuivre de cément",
        "740200": "Cuivre non affiné, anodes pour affinage électrolytique",
        "740311": "Cathodes et sections de cathodes en cuivre affiné",
        "740312": "Barres à fil (wire-bars) en cuivre affiné",
        "740313": "Billettes en cuivre affiné",
        "740319": "Cuivre affiné sous autres formes brutes",
    }),
    ("Cuivre", "raffinage", "alliage", {
        "740321": "Alliages cuivre-zinc (laiton) sous forme brute",
        "740322": "Alliages cuivre-étain (bronze) sous forme brute",
        "740329": "Autres alliages de cuivre sous forme brute",
    }),
    ("Cuivre", "transformation", "dechet", {
        "740400": "Déchets et débris de cuivre",
    }),
    ("Cuivre", "transformation", "alliage", {
        "740500": "Alliages mères de cuivre",
    }),
    ("Cuivre", "transformation", "demi_produit", {
        "740710": "Barres et profilés en cuivre affiné",
        "740721": "Barres et profilés en alliages cuivre-zinc (laiton)",
        "740729": "Barres et profilés en autres alliages de cuivre",
        "740811": "Fils en cuivre affiné, plus grande dimension supérieure à 6 mm",
        "740819": "Autres fils en cuivre affiné",
        "740821": "Fils en alliages cuivre-zinc (laiton)",
        "740829": "Fils en autres alliages de cuivre",
    }),
    ("Cuivre", "fini", "produit_fini", {
        "741300": "Torons, câbles et tresses en cuivre, non isolés",
        "854411": "Fils pour bobinages en cuivre",
        "854442": "Conducteurs électriques isolés munis de connecteurs",
        "854449": "Autres conducteurs électriques isolés, 1 000 V ou moins",
        "854460": "Conducteurs électriques isolés pour plus de 1 000 V",
    }),
    # -------------------------------------------------------------- Aluminium
    ("Aluminium", "extraction", "minerai", {
        "260600": "Minerais d'aluminium et leurs concentrés (bauxite)",
    }),
    ("Aluminium", "raffinage", "oxyde", {
        "281820": "Oxyde d'aluminium (alumine), autre que le corindon artificiel",
        "281830": "Hydroxyde d'aluminium",
    }),
    ("Aluminium", "raffinage", "metal_brut", {
        "760110": "Aluminium brut non allié",
    }),
    ("Aluminium", "raffinage", "alliage", {
        "760120": "Alliages d'aluminium sous forme brute",
    }),
    ("Aluminium", "transformation", "dechet", {
        "760200": "Déchets et débris d'aluminium",
    }),
    ("Aluminium", "transformation", "poudre", {
        "760310": "Poudres d'aluminium à structure non lamellaire",
        "760320": "Poudres d'aluminium à structure lamellaire, paillettes",
    }),
    ("Aluminium", "transformation", "demi_produit", {
        "760410": "Barres et profilés en aluminium non allié",
        "760421": "Profilés creux en alliages d'aluminium",
        "760429": "Autres barres et profilés en alliages d'aluminium",
        "760511": "Fils en aluminium non allié, section supérieure à 7 mm",
        "760519": "Autres fils en aluminium non allié",
        "760521": "Fils en alliages d'aluminium, section supérieure à 7 mm",
        "760529": "Autres fils en alliages d'aluminium",
        "760611": "Tôles et bandes rectangulaires en aluminium non allié",
        "760612": "Tôles et bandes rectangulaires en alliages d'aluminium",
        "760691": "Autres tôles et bandes en aluminium non allié",
        "760692": "Autres tôles et bandes en alliages d'aluminium",
    }),
    ("Aluminium", "fini", "produit_fini", {
        "761090": "Constructions et parties de constructions en aluminium",
        "761100": "Réservoirs et cuves en aluminium de plus de 300 litres",
        "761510": "Articles de ménage et d'économie domestique en aluminium",
    }),
    # ------------------------------------------------------------------- Zinc
    ("Zinc", "extraction", "minerai", {
        "260800": "Minerais de zinc et leurs concentrés",
    }),
    ("Zinc", "raffinage", "oxyde", {
        "281700": "Oxyde et peroxyde de zinc",
    }),
    ("Zinc", "raffinage", "metal_brut", {
        "790111": "Zinc brut non allié titrant au moins 99,99 % de zinc",
        "790112": "Zinc brut non allié titrant moins de 99,99 % de zinc",
    }),
    ("Zinc", "raffinage", "alliage", {
        "790120": "Alliages de zinc sous forme brute",
    }),
    ("Zinc", "transformation", "dechet", {
        "790200": "Déchets et débris de zinc",
    }),
    ("Zinc", "transformation", "poudre", {
        "790310": "Poussières de zinc",
    }),
    ("Zinc", "transformation", "demi_produit", {
        "790400": "Barres, profilés et fils en zinc",
        "790500": "Tôles, feuilles et bandes en zinc",
    }),
    ("Zinc", "fini", "produit_fini", {
        "790700": "Ouvrages en zinc",
    }),
]

# code HS6 -> {mineral, stade, forme, labelFr, categorie}
#
# `categorie` reste peuplé avec le libellé du stade : la colonne du même nom est
# figée dans les Parquet déjà publiés, et la webapp ne la lit plus (elle filtre
# sur cmdCode, voir webapp/js/labels.js). Le champ est conservé pour qu'un
# ré-export produise des Parquet cohérents avec la taxonomie courante.
CRITICAL_MINERALS_HS6 = {
    code: {
        "mineral": mineral,
        "stade": stade,
        "forme": forme,
        "labelFr": label,
        "categorie": STADE_LABELS[stade],
    }
    for mineral, stade, forme, codes in _MATIERES
    for code, label in codes.items()
}

# Colonnes attendues dans une réponse valide de l'API
COLONNES_ATTENDUES = [
    "period",
    "reporterCode",
    "reporterDesc",
    "partnerCode",
    "partnerDesc",
    "flowCode",
    "flowDesc",
    "cmdCode",
    "cmdDesc",
    "primaryValue",
    "netWgt",
    "qty",
    "qtyUnitAbbr",
]


def verifier_cle_api():
    """Vérifie que la clé API est bien présente, sort proprement sinon."""
    if not COMTRADE_API_KEY:
        raise SystemExit(
            "COMTRADE_API_KEY manquante. Copie .env.example en .env et "
            "renseigne ta clé API UN Comtrade."
        )
