"""
Chargement idempotent des fichiers CSV bruts (data/raw/) vers la base
DuckDB locale (data/comtrade.duckdb).

Usage :
    python scraper/load_to_db.py
"""

import os

import duckdb
import pandas as pd
from tqdm import tqdm

import config
import reference_data

COLONNES_TRADE_RECORDS = ", ".join(config.COLONNES_ATTENDUES)


def creer_tables(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS trade_records (
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
        """
        CREATE TABLE IF NOT EXISTS loaded_files (
            filename VARCHAR PRIMARY KEY,
            loaded_at TIMESTAMP,
            row_count BIGINT
        )
        """
    )


def charger_fichiers_bruts(con: duckdb.DuckDBPyConnection) -> int:
    """Charge dans trade_records tout fichier de data/raw/ pas encore
    présent dans loaded_files. Idempotent : relancer ne recharge rien."""
    fichiers = sorted(config.RAW_DIR.glob("*.csv"))
    deja_charges = {row[0] for row in con.execute("SELECT filename FROM loaded_files").fetchall()}
    nouveaux = [f for f in fichiers if f.name not in deja_charges]

    for fichier in tqdm(nouveaux, desc="Chargement DuckDB"):
        con.execute(
            f"""
            INSERT INTO trade_records
            SELECT {COLONNES_TRADE_RECORDS} FROM read_csv_auto(?)
            """,
            [str(fichier)],
        )
        nb_lignes = con.execute(
            "SELECT COUNT(*) FROM read_csv_auto(?)", [str(fichier)]
        ).fetchone()[0]
        con.execute(
            "INSERT INTO loaded_files VALUES (?, now(), ?)",
            [fichier.name, nb_lignes],
        )
    return len(nouveaux)


def creer_index(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("CREATE INDEX IF NOT EXISTS idx_period ON trade_records(period)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_reporter ON trade_records(reporterCode)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_partner ON trade_records(partnerCode)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_cmd ON trade_records(cmdCode)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_flow ON trade_records(flowCode)")


def charger_table_reference(con: duckdb.DuckDBPyConnection, nom_table: str, df: pd.DataFrame) -> None:
    con.register(f"{nom_table}_view", df)
    con.execute(f"CREATE OR REPLACE TABLE {nom_table} AS SELECT * FROM {nom_table}_view")
    con.unregister(f"{nom_table}_view")


def charger_references(con: duckdb.DuckDBPyConnection) -> None:
    charger_table_reference(con, "reporters", reference_data.get_reporters())
    charger_table_reference(con, "hs_codes", reference_data.get_hs_reference())
    charger_table_reference(con, "flows", reference_data.get_flows())


def afficher_resume(con: duckdb.DuckDBPyConnection) -> None:
    total, annee_min, annee_max, nb_reporters = con.execute(
        """
        SELECT COUNT(*), MIN(period), MAX(period), COUNT(DISTINCT reporterCode)
        FROM trade_records
        """
    ).fetchone()

    taille_mo = os.path.getsize(config.DB_PATH) / (1024 * 1024) if config.DB_PATH.exists() else 0

    print("\n=== Résumé data/comtrade.duckdb ===")
    print(f"Lignes totales      : {total:,}")
    print(f"Plage d'années      : {annee_min} - {annee_max}")
    print(f"Reporters distincts : {nb_reporters}")
    print(f"Taille du fichier   : {taille_mo:.1f} Mo")

    if total:
        print("\n% de nulls par colonne :")
        for colonne in config.COLONNES_ATTENDUES:
            pct = con.execute(
                f"SELECT 100.0 * SUM(CASE WHEN {colonne} IS NULL THEN 1 ELSE 0 END) / COUNT(*) FROM trade_records"
            ).fetchone()[0]
            print(f"  {colonne:<15} {pct:.1f}%")


def main() -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(config.DB_PATH))
    try:
        creer_tables(con)
        nb_charges = charger_fichiers_bruts(con)
        creer_index(con)
        charger_references(con)
        print(f"{nb_charges} nouveau(x) fichier(s) chargé(s).")
        afficher_resume(con)
    finally:
        con.close()


if __name__ == "__main__":
    main()
