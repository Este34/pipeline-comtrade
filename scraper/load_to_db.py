"""
Chargement idempotent des fichiers CSV bruts vers la base DuckDB locale
(data/comtrade.duckdb).

Usage :
    python scraper/load_to_db.py              # dataset HS2 principal -> trade_records
    python scraper/load_to_db.py --critical    # dataset HS6 critique -> trade_critical
"""

import argparse
import os

import duckdb
import pandas as pd
from tqdm import tqdm

import config
import reference_data

COLONNES_TRADE_RECORDS = ", ".join(config.COLONNES_ATTENDUES)


def creer_tables(con: duckdb.DuckDBPyConnection, table: str, loaded: str) -> None:
    con.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table} (
            period INTEGER,
            reporterCode VARCHAR,
            reporterDesc VARCHAR,
            partnerCode VARCHAR,
            partnerDesc VARCHAR,
            flowCode VARCHAR,
            flowDesc VARCHAR,
            cmdCode VARCHAR,
            cmdDesc VARCHAR,
            primaryValue DOUBLE,
            netWgt DOUBLE,
            qty DOUBLE,
            qtyUnitAbbr VARCHAR
        )
        """
    )
    con.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {loaded} (
            filename VARCHAR PRIMARY KEY,
            loaded_at TIMESTAMP,
            row_count BIGINT
        )
        """
    )


def charger_fichiers_bruts(con: duckdb.DuckDBPyConnection, table: str, loaded: str) -> int:
    """Charge dans `table` tout fichier de config.RAW_DIR pas encore présent
    dans `loaded`. Idempotent : relancer ne recharge rien."""
    fichiers = sorted(config.RAW_DIR.glob("*.csv"))
    deja_charges = {row[0] for row in con.execute(f"SELECT filename FROM {loaded}").fetchall()}
    nouveaux = [f for f in fichiers if f.name not in deja_charges]

    for fichier in tqdm(nouveaux, desc="Chargement DuckDB"):
        con.execute(
            f"""
            INSERT INTO {table}
            SELECT {COLONNES_TRADE_RECORDS} FROM read_csv_auto(?)
            """,
            [str(fichier)],
        )
        nb_lignes = con.execute(
            "SELECT COUNT(*) FROM read_csv_auto(?)", [str(fichier)]
        ).fetchone()[0]
        con.execute(
            f"INSERT INTO {loaded} VALUES (?, now(), ?)",
            [fichier.name, nb_lignes],
        )
    return len(nouveaux)


def creer_index(con: duckdb.DuckDBPyConnection, table: str) -> None:
    for colonne in ("period", "reporterCode", "partnerCode", "cmdCode", "flowCode"):
        con.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{table}_{colonne} ON {table}({colonne})"
        )


def charger_table_reference(con: duckdb.DuckDBPyConnection, nom_table: str, df: pd.DataFrame) -> None:
    con.register(f"{nom_table}_view", df)
    con.execute(f"CREATE OR REPLACE TABLE {nom_table} AS SELECT * FROM {nom_table}_view")
    con.unregister(f"{nom_table}_view")


def charger_references(con: duckdb.DuckDBPyConnection) -> None:
    charger_table_reference(con, "reporters", reference_data.get_reporters())
    charger_table_reference(con, "hs_codes", reference_data.get_hs_reference())
    charger_table_reference(con, "flows", reference_data.get_flows())


def afficher_resume(con: duckdb.DuckDBPyConnection, table: str) -> None:
    total, annee_min, annee_max, nb_reporters = con.execute(
        f"""
        SELECT COUNT(*), MIN(period), MAX(period), COUNT(DISTINCT reporterCode)
        FROM {table}
        """
    ).fetchone()

    taille_mo = os.path.getsize(config.DB_PATH) / (1024 * 1024) if config.DB_PATH.exists() else 0

    print(f"\n=== Résumé table {table} (data/comtrade.duckdb) ===")
    print(f"Lignes totales      : {total:,}")
    print(f"Plage d'années      : {annee_min} - {annee_max}")
    print(f"Reporters distincts : {nb_reporters}")
    print(f"Taille du fichier   : {taille_mo:.1f} Mo")

    if total:
        print("\n% de nulls par colonne :")
        for colonne in config.COLONNES_ATTENDUES:
            pct = con.execute(
                f"SELECT 100.0 * SUM(CASE WHEN {colonne} IS NULL THEN 1 ELSE 0 END) / COUNT(*) FROM {table}"
            ).fetchone()[0]
            print(f"  {colonne:<15} {pct:.1f}%")


def main() -> None:
    parser = argparse.ArgumentParser(description="Chargement CSV -> DuckDB")
    parser.add_argument(
        "--critical",
        action="store_true",
        help="Charge data/raw_critical/ dans la table trade_critical",
    )
    args = parser.parse_args()

    if args.critical:
        config.RAW_DIR = config.RAW_CRITICAL_DIR
        table, loaded = "trade_critical", "loaded_files_critical"
    else:
        table, loaded = "trade_records", "loaded_files"

    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(config.DB_PATH))
    try:
        creer_tables(con, table, loaded)
        nb_charges = charger_fichiers_bruts(con, table, loaded)
        creer_index(con, table)
        # Les tables de référence ne sont (re)chargées qu'avec le dataset principal.
        if not args.critical:
            charger_references(con)
        print(f"{nb_charges} nouveau(x) fichier(s) chargé(s).")
        afficher_resume(con, table)
    finally:
        con.close()


if __name__ == "__main__":
    main()
