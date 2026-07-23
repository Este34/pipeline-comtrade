"""
Phase 2/3 : nettoyage léger + export Parquet depuis data/comtrade.duckdb.

Produit sous data/parquet/ :
  - detail/period=YYYY/data.parquet    : détail complet enrichi, partitionné par année
  - aggregat/data.parquet               : lignes agrégées (partenaire World ou cmd TOTAL)
  - reference/*.parquet                 : reporters, hs_codes, flows, continents
  - critical/period=YYYY/data.parquet    : dataset HS6 minéraux critiques (--critical)

Export 100 % natif DuckDB (COPY ... TO), sans round-trip pandas, pour tenir la
volumétrie (~36 M lignes).

Usage :
    python clean/clean_export.py               # dataset HS2 principal
    python clean/clean_export.py --critical     # dataset HS6 minéraux critiques
"""

import argparse
import os
import sys
from pathlib import Path

import duckdb
import pandas as pd
from tqdm import tqdm

SCRAPER_DIR = Path(__file__).resolve().parent.parent / "scraper"
sys.path.insert(0, str(SCRAPER_DIR))

import config  # noqa: E402

import enrich  # noqa: E402

# Colonnes enrichies ajoutées au détail (reporter + partner).
SELECT_ENRICHI = """
    t.*,
    er.iso3 AS reporterISO3, er.continent AS reporterContinent,
    ep.iso3 AS partnerISO3, ep.continent AS partnerContinent
    FROM trade_records t
    LEFT JOIN enrich er ON er.code = t.reporterCode
    LEFT JOIN enrich ep ON ep.code = t.partnerCode
"""


def preparer_dossiers() -> None:
    for d in (
        config.PARQUET_DETAIL_DIR,
        config.PARQUET_AGGREGAT_DIR,
        config.PARQUET_REFERENCE_DIR,
    ):
        d.mkdir(parents=True, exist_ok=True)


def enregistrer_enrichissement(con: duckdb.DuckDBPyConnection) -> int:
    """Charge la table d'enrichissement en mémoire DuckDB. Renvoie le nb de
    codes sans continent (contrôle qualité)."""
    mapping = enrich.build_enrichment()
    con.register("enrich_view", mapping)
    con.execute("CREATE TEMP TABLE enrich AS SELECT * FROM enrich_view")
    con.unregister("enrich_view")
    return int(mapping["continent"].isna().sum())


def exporter_detail(con: duckdb.DuckDBPyConnection) -> None:
    """Exporte le détail complet, une partition Parquet par année."""
    annees = [
        r[0]
        for r in con.execute(
            "SELECT DISTINCT period FROM trade_records ORDER BY period"
        ).fetchall()
    ]
    for annee in tqdm(annees, desc="Export détail"):
        dossier = config.PARQUET_DETAIL_DIR / f"period={annee}"
        dossier.mkdir(parents=True, exist_ok=True)
        cible = (dossier / "data.parquet").as_posix()
        con.execute(
            f"""
            COPY (SELECT {SELECT_ENRICHI} WHERE t.period = {annee})
            TO '{cible}' (FORMAT PARQUET, COMPRESSION ZSTD)
            """
        )


def exporter_aggregat(con: duckdb.DuckDBPyConnection) -> None:
    """Exporte les seules lignes agrégées (partenaire World ou cmd TOTAL)."""
    cible = (config.PARQUET_AGGREGAT_DIR / "data.parquet").as_posix()
    con.execute(
        f"""
        COPY (
            SELECT {SELECT_ENRICHI}
            WHERE t.partnerCode = '0' OR t.cmdCode = 'TOTAL'
        )
        TO '{cible}' (FORMAT PARQUET, COMPRESSION ZSTD)
        """
    )


def exporter_references(con: duckdb.DuckDBPyConnection) -> None:
    """Exporte les tables de référence + la table continents (enrichissement)."""
    for table in ("reporters", "hs_codes", "flows", "enrich"):
        nom_fichier = "continents" if table == "enrich" else table
        cible = (config.PARQUET_REFERENCE_DIR / f"{nom_fichier}.parquet").as_posix()
        con.execute(f"COPY {table} TO '{cible}' (FORMAT PARQUET, COMPRESSION ZSTD)")


def taille_repertoire(chemin: Path) -> int:
    return sum(f.stat().st_size for f in chemin.rglob("*") if f.is_file())


def afficher_resume(con: duckdb.DuckDBPyConnection, codes_sans_continent: int) -> None:
    detail_glob = (config.PARQUET_DETAIL_DIR / "*" / "*.parquet").as_posix()
    total, iso3_ok, cont_ok = con.execute(
        f"""
        SELECT COUNT(*), COUNT(reporterISO3), COUNT(reporterContinent)
        FROM read_parquet('{detail_glob}')
        """
    ).fetchone()
    total_source = con.execute("SELECT COUNT(*) FROM trade_records").fetchone()[0]
    agg_glob = (config.PARQUET_AGGREGAT_DIR / "data.parquet").as_posix()
    total_agg = con.execute(f"SELECT COUNT(*) FROM read_parquet('{agg_glob}')").fetchone()[0]
    nb_partitions = len(list(config.PARQUET_DETAIL_DIR.glob("period=*")))

    print("\n=== Résumé export Parquet (data/parquet/) ===")
    print(f"Partitions détail   : {nb_partitions} (une par année)")
    print(f"Lignes détail       : {total:,}  (source trade_records : {total_source:,})")
    print(f"Cohérence lignes    : {'OK' if total == total_source else 'ECART !'}")
    print(f"Lignes agrégat      : {total_agg:,}")
    print(f"ISO3 renseignés     : {100 * iso3_ok / total:.1f}% des lignes")
    print(f"Continents renseignés : {100 * cont_ok / total:.1f}% (nuls = codes spéciaux/groupes)")
    print(f"Codes sans continent : {codes_sans_continent} (World, zones nes, groupes)")
    print(f"Taille détail       : {taille_repertoire(config.PARQUET_DETAIL_DIR) / 1024 / 1024:.1f} Mo")
    print(f"Taille agrégat      : {os.path.getsize(agg_glob) / 1024 / 1024:.1f} Mo")
    print(f"Taille totale       : {taille_repertoire(config.PARQUET_DIR) / 1024 / 1024:.1f} Mo")


def enregistrer_mineraux(con: duckdb.DuckDBPyConnection) -> None:
    """Enregistre la correspondance code HS6 -> minéral FR comme table DuckDB."""
    df = pd.DataFrame(
        [{"cmdCode": k, "mineral": v} for k, v in config.CRITICAL_MINERALS_HS6.items()]
    )
    con.register("min_view", df)
    con.execute("CREATE TEMP TABLE mineraux AS SELECT * FROM min_view")
    con.unregister("min_view")


def exporter_critical(con: duckdb.DuckDBPyConnection) -> None:
    """Exporte le dataset HS6 minéraux critiques, enrichi (ISO3, continent,
    minéral FR), une partition Parquet par année."""
    config.PARQUET_CRITICAL_DIR.mkdir(parents=True, exist_ok=True)
    annees = [
        r[0]
        for r in con.execute(
            "SELECT DISTINCT period FROM trade_critical ORDER BY period"
        ).fetchall()
    ]
    for annee in tqdm(annees, desc="Export critical"):
        dossier = config.PARQUET_CRITICAL_DIR / f"period={annee}"
        dossier.mkdir(parents=True, exist_ok=True)
        cible = (dossier / "data.parquet").as_posix()
        con.execute(
            f"""
            COPY (
                SELECT t.*,
                    er.iso3 AS reporterISO3, er.continent AS reporterContinent,
                    ep.iso3 AS partnerISO3, ep.continent AS partnerContinent,
                    m.mineral AS mineral
                FROM trade_critical t
                LEFT JOIN enrich er ON er.code = t.reporterCode
                LEFT JOIN enrich ep ON ep.code = t.partnerCode
                LEFT JOIN mineraux m ON m.cmdCode = t.cmdCode
                WHERE t.period = {annee}
            )
            TO '{cible}' (FORMAT PARQUET, COMPRESSION ZSTD)
            """
        )


def afficher_resume_critical(con: duckdb.DuckDBPyConnection) -> None:
    glob = (config.PARQUET_CRITICAL_DIR / "*" / "*.parquet").as_posix()
    total, source = (
        con.execute(f"SELECT COUNT(*) FROM read_parquet('{glob}')").fetchone()[0],
        con.execute("SELECT COUNT(*) FROM trade_critical").fetchone()[0],
    )
    nb_min = con.execute(
        f"SELECT COUNT(DISTINCT mineral) FROM read_parquet('{glob}')"
    ).fetchone()[0]
    nb_part = len(list(config.PARQUET_CRITICAL_DIR.glob("period=*")))
    print("\n=== Résumé export critical (data/parquet/critical/) ===")
    print(f"Partitions          : {nb_part} (une par année)")
    print(f"Lignes              : {total:,}  (source trade_critical : {source:,})")
    print(f"Cohérence           : {'OK' if total == source else 'ECART !'}")
    print(f"Minéraux distincts  : {nb_min}")
    print(f"Taille              : {taille_repertoire(config.PARQUET_CRITICAL_DIR) / 1024 / 1024:.1f} Mo")


def main() -> None:
    parser = argparse.ArgumentParser(description="Export Parquet Comtrade")
    parser.add_argument(
        "--critical",
        action="store_true",
        help="Exporte le dataset HS6 minéraux critiques (table trade_critical)",
    )
    args = parser.parse_args()

    if not config.DB_PATH.exists():
        raise SystemExit(f"Base introuvable : {config.DB_PATH}. Lance d'abord la Phase 1.")

    con = duckdb.connect(str(config.DB_PATH), read_only=True)
    try:
        codes_sans_continent = enregistrer_enrichissement(con)
        if args.critical:
            enregistrer_mineraux(con)
            exporter_critical(con)
            afficher_resume_critical(con)
        else:
            preparer_dossiers()
            exporter_detail(con)
            exporter_aggregat(con)
            exporter_references(con)
            afficher_resume(con, codes_sans_continent)
    finally:
        con.close()


if __name__ == "__main__":
    main()
