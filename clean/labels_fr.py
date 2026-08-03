"""
Génère les fichiers de traduction FR chargés directement par la webapp
(sans DuckDB), dans webapp/data/reference/ :
  - countries_fr.json    : ISO3 -> nom de pays FR (via pycountry, locale FR)
  - hs_chapters_fr.json   : chapitre HS (01..97) -> intitulé FR (table curée WCO)
  - materiaux_fr.json      : référentiel matières (stades, formes, codes HS6)
  - flows_fr.json           : code flux -> libellé FR

Ces fichiers sont petits (quelques Ko) : la webapp les charge en JSON pur pour
afficher des libellés lisibles sans jointure DuckDB.
"""

import gettext
import json
import sys
from datetime import date
from pathlib import Path

import pycountry

SCRAPER_DIR = Path(__file__).resolve().parent.parent / "scraper"
sys.path.insert(0, str(SCRAPER_DIR))

import config  # noqa: E402

import reference_data  # noqa: E402

WEBAPP_REFERENCE_DIR = config.BASE_DIR / "webapp" / "data" / "reference"

# Intitulés FR des 97 chapitres HS (nomenclature du Système Harmonisé, OMD).
# Table curée une fois pour toutes ; les libellés Comtrade sont en anglais.
HS_CHAPITRES_FR = {
    "01": "Animaux vivants",
    "02": "Viandes et abats comestibles",
    "03": "Poissons, crustacés et mollusques",
    "04": "Laits, produits laitiers, œufs, miel",
    "05": "Autres produits d'origine animale",
    "06": "Plantes vivantes et floriculture",
    "07": "Légumes, plantes, racines et tubercules",
    "08": "Fruits comestibles, agrumes, melons",
    "09": "Café, thé, maté et épices",
    "10": "Céréales",
    "11": "Produits de la minoterie, amidons",
    "12": "Graines et fruits oléagineux",
    "13": "Gommes, résines et sucs végétaux",
    "14": "Matières à tresser et produits végétaux",
    "15": "Graisses et huiles animales ou végétales",
    "16": "Préparations de viandes et de poissons",
    "17": "Sucres et sucreries",
    "18": "Cacao et ses préparations",
    "19": "Préparations à base de céréales et pâtisserie",
    "20": "Préparations de légumes et de fruits",
    "21": "Préparations alimentaires diverses",
    "22": "Boissons, liquides alcooliques et vinaigres",
    "23": "Résidus alimentaires et aliments pour animaux",
    "24": "Tabacs et succédanés de tabac",
    "25": "Sel, soufre, terres et pierres, plâtres, chaux",
    "26": "Minerais, scories et cendres",
    "27": "Combustibles minéraux, huiles, bitumes",
    "28": "Produits chimiques inorganiques",
    "29": "Produits chimiques organiques",
    "30": "Produits pharmaceutiques",
    "31": "Engrais",
    "32": "Tanins, teintures, pigments, peintures",
    "33": "Huiles essentielles, parfumerie, cosmétiques",
    "34": "Savons, cires, produits d'entretien",
    "35": "Matières albuminoïdes, colles, enzymes",
    "36": "Poudres et explosifs, articles de pyrotechnie",
    "37": "Produits photographiques ou cinématographiques",
    "38": "Produits divers des industries chimiques",
    "39": "Matières plastiques et ouvrages",
    "40": "Caoutchouc et ouvrages en caoutchouc",
    "41": "Peaux et cuirs",
    "42": "Ouvrages en cuir, maroquinerie, sellerie",
    "43": "Pelleteries, fourrures et ouvrages",
    "44": "Bois, charbon de bois et ouvrages en bois",
    "45": "Liège et ouvrages en liège",
    "46": "Ouvrages de sparterie et de vannerie",
    "47": "Pâtes de bois, papier à recycler",
    "48": "Papiers et cartons et leurs ouvrages",
    "49": "Produits de l'édition, presse, imprimés",
    "50": "Soie",
    "51": "Laine, poils et crins",
    "52": "Coton",
    "53": "Autres fibres textiles végétales",
    "54": "Filaments synthétiques ou artificiels",
    "55": "Fibres synthétiques ou artificielles discontinues",
    "56": "Ouates, feutres, cordages et articles textiles",
    "57": "Tapis et revêtements de sol textiles",
    "58": "Tissus spéciaux, dentelles, tapisseries",
    "59": "Tissus imprégnés, enduits ou stratifiés",
    "60": "Étoffes de bonneterie",
    "61": "Vêtements en bonneterie",
    "62": "Vêtements autres qu'en bonneterie",
    "63": "Autres articles textiles confectionnés",
    "64": "Chaussures, guêtres et articles analogues",
    "65": "Coiffures et parties de coiffures",
    "66": "Parapluies, ombrelles, cannes, fouets",
    "67": "Plumes et duvet apprêtés, fleurs artificielles",
    "68": "Ouvrages en pierres, plâtre, ciment",
    "69": "Produits céramiques",
    "70": "Verre et ouvrages en verre",
    "71": "Perles, pierres et métaux précieux, bijouterie",
    "72": "Fonte, fer et acier",
    "73": "Ouvrages en fonte, fer ou acier",
    "74": "Cuivre et ouvrages en cuivre",
    "75": "Nickel et ouvrages en nickel",
    "76": "Aluminium et ouvrages en aluminium",
    "78": "Plomb et ouvrages en plomb",
    "79": "Zinc et ouvrages en zinc",
    "80": "Étain et ouvrages en étain",
    "81": "Autres métaux communs, cermets",
    "82": "Outils et outillage en métaux communs",
    "83": "Ouvrages divers en métaux communs",
    "84": "Machines, réacteurs, chaudières, appareils",
    "85": "Machines et matériels électriques",
    "86": "Véhicules et matériel ferroviaires",
    "87": "Véhicules automobiles, tracteurs, cycles",
    "88": "Navigation aérienne ou spatiale",
    "89": "Navigation maritime ou fluviale",
    "90": "Instruments d'optique, de mesure, médicaux",
    "91": "Horlogerie",
    "92": "Instruments de musique",
    "93": "Armes, munitions et leurs parties",
    "94": "Meubles, literie, luminaires, constructions préfabriquées",
    "95": "Jouets, jeux, articles de sport",
    "96": "Ouvrages divers",
    "97": "Objets d'art, de collection ou d'antiquité",
    "99": "Marchandises non classées ailleurs",
    "TOTAL": "Tous produits confondus",
}


def _traducteur_pays():
    fr = gettext.translation("iso3166-1", pycountry.LOCALES_DIR, languages=["fr"])
    return fr.gettext


def countries_fr() -> dict[str, str]:
    """ISO3 -> nom FR. Fallback sur le nom Comtrade si absent de pycountry."""
    traduire = _traducteur_pays()
    reporters = reference_data.get_reporters()
    result: dict[str, str] = {}
    for _, r in reporters.iterrows():
        iso3 = str(r["reporterCodeIsoAlpha3"])
        pays = pycountry.countries.get(alpha_3=iso3)
        result[iso3] = traduire(pays.name) if pays else str(r["reporterDesc"])
    return result


def ecrire_json(nom: str, donnees: dict, nb: int | None = None) -> None:
    chemin = WEBAPP_REFERENCE_DIR / nom
    with open(chemin, "w", encoding="utf-8") as f:
        json.dump(donnees, f, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"  {nom:<22} {len(donnees) if nb is None else nb} entrées")


def materiaux_fr() -> dict:
    """Référentiel matières : stades, formes, et un enregistrement par code HS6.

    Ce fichier est la SOURCE DE VÉRITÉ de la taxonomie côté webapp. Les colonnes
    `mineral` / `categorie` figées dans les Parquet ne sont plus lues : la webapp
    convertit une sélection (minéraux, stades, formes) en liste de codes HS6 et
    filtre sur `cmdCode`. Reclasser un code ou renommer un stade se fait donc en
    régénérant ce fichier de quelques Ko, sans toucher aux ~290 Mo de Parquet.
    """
    return {
        "stades": config.STADES,
        "formes": config.FORMES,
        "codes": {code: dict(v) for code, v in config.CRITICAL_MINERALS_HS6.items()},
    }


def dataset_fr() -> dict:
    """Fiche du jeu de données lue par la webapp pour afficher la source, la
    période couverte et la date de mise à jour. Régénérée à chaque passage du
    pipeline : `date_maj` porte donc le jour de la dernière extraction/export.
    """
    return {
        "source": "UN Comtrade",
        "source_url": "https://comtradeplus.un.org",
        "periode": {"debut": config.ANNEE_DEBUT, "fin": config.ANNEE_FIN},
        "date_maj": date.today().isoformat(),
    }


def main() -> None:
    WEBAPP_REFERENCE_DIR.mkdir(parents=True, exist_ok=True)
    print("Génération des libellés FR (webapp/data/reference/) :")
    ecrire_json("countries_fr.json", countries_fr())
    ecrire_json("hs_chapters_fr.json", HS_CHAPITRES_FR)
    mat = materiaux_fr()
    ecrire_json("materiaux_fr.json", mat, nb=len(mat["codes"]))
    ecrire_json("flows_fr.json", {"M": "Importations", "X": "Exportations"})
    ecrire_json("dataset_fr.json", dataset_fr(), nb=1)


if __name__ == "__main__":
    main()
