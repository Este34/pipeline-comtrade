"""
Enrichissement géographique : correspondance code pays Comtrade (M49) →
ISO3 + continent, valable pour les reporters comme pour les partenaires.

Les références Comtrade fournissent l'ISO2/ISO3 mais pas le continent ; ce
dernier est dérivé de l'ISO2 via pycountry_convert. Les codes spéciaux Comtrade
(World, « Areas nes », zones franches, groupes régionaux) n'ont pas de continent
et ressortent avec continent = None (comportement voulu).
"""

import sys
from pathlib import Path

import pandas as pd
import pycountry_convert as pc

# Réutilise config + reference_data de la Phase 1 (dossier scraper/).
SCRAPER_DIR = Path(__file__).resolve().parent.parent / "scraper"
sys.path.insert(0, str(SCRAPER_DIR))

import comtradeapicall  # noqa: E402

import reference_data  # noqa: E402

# Code continent pycountry (AF, AS, EU, NA, SA, OC) → libellé lisible.
CONTINENTS = {
    "AF": "Afrique",
    "AS": "Asie",
    "EU": "Europe",
    "NA": "Amérique du Nord",
    "SA": "Amérique du Sud",
    "OC": "Océanie",
    "AN": "Antarctique",
}


def _continent_depuis_iso2(iso2: str | None) -> str | None:
    """Renvoie le libellé de continent pour un code ISO2, ou None si le code
    est absent/spécial (groupes, zones nes, World...)."""
    if not iso2 or pd.isna(iso2):
        return None
    try:
        code = pc.country_alpha2_to_continent_code(iso2)
    except KeyError:
        return None
    return CONTINENTS.get(code)


def build_enrichment() -> pd.DataFrame:
    """Construit la table de correspondance code → (iso3, continent).

    Fusionne les référentiels reporter et partner : les partenaires couvrent
    un sur-ensemble de codes (davantage de territoires/zones), on les prend
    donc en priorité et on complète avec les reporters."""
    reporters = reference_data.get_reporters()[
        ["reporterCode", "reporterCodeIsoAlpha2", "reporterCodeIsoAlpha3"]
    ].rename(
        columns={
            "reporterCode": "code",
            "reporterCodeIsoAlpha2": "iso2",
            "reporterCodeIsoAlpha3": "iso3",
        }
    )

    partners = comtradeapicall.getReference("partner")[
        ["PartnerCode", "PartnerCodeIsoAlpha2", "PartnerCodeIsoAlpha3"]
    ].rename(
        columns={
            "PartnerCode": "code",
            "PartnerCodeIsoAlpha2": "iso2",
            "PartnerCodeIsoAlpha3": "iso3",
        }
    )

    mapping = pd.concat([partners, reporters], ignore_index=True)
    mapping["code"] = mapping["code"].astype(str)
    mapping = mapping.drop_duplicates(subset="code", keep="first")

    mapping["continent"] = mapping["iso2"].map(_continent_depuis_iso2)
    return mapping[["code", "iso3", "continent"]]
