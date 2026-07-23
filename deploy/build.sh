#!/usr/bin/env bash
# Build Vercel : récupère les Parquet et le moteur DuckDB-WASM depuis les assets
# d'une release GitHub, puis les dépose dans webapp/ (= outputDirectory).
#
# Ces fichiers pèsent ~290 Mo et sont exclus de git. Les faire arriver en SORTIE
# de build (et non en source) est ce qui permet de tenir dans le plafond Vercel
# de 100 Mo d'upload de sources sur le plan Hobby.
set -euo pipefail

DEPOT="${ASSETS_REPO:-Este34/pipeline-comtrade}"
TAG="${ASSETS_TAG:-donnees-v1}"
ARCHIVE="webapp-assets.tar.gz"

if [ -n "${GITHUB_TOKEN:-}" ]; then
  # Dépôt privé : les assets ne sont pas servis en accès anonyme. Il faut passer
  # par l'API, qui exige l'identifiant numérique de l'asset (l'URL /releases/
  # download/ ne fonctionne pas avec un jeton). Node est toujours présent dans
  # le conteneur de build Vercel, contrairement à jq.
  echo "Dépôt privé : résolution de l'asset ${ARCHIVE} (release ${TAG}) via l'API."
  ASSET_ID=$(
    curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      "https://api.github.com/repos/${DEPOT}/releases/tags/${TAG}" |
      node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        const a=(JSON.parse(d).assets||[]).find(x=>x.name===process.argv[1]);
        if(!a){console.error("Asset "+process.argv[1]+" absent de la release.");process.exit(1)}
        console.log(a.id)})' "${ARCHIVE}"
  )
  SOURCE="https://api.github.com/repos/${DEPOT}/releases/assets/${ASSET_ID}"
  ENTETES=(-H "Authorization: Bearer ${GITHUB_TOKEN}" -H "Accept: application/octet-stream")
else
  # Dépôt public : URL de téléchargement directe, aucun jeton nécessaire.
  SOURCE="https://github.com/${DEPOT}/releases/download/${TAG}/${ARCHIVE}"
  ENTETES=()
fi

echo "Téléchargement des données (release ${TAG})..."
curl -fsSL --retry 3 --retry-delay 2 "${ENTETES[@]}" "${SOURCE}" | tar -xzf - -C webapp

# Vérification explicite : sans ce garde-fou, un build qui réussit avec une
# archive incomplète produirait un site cassé seulement à l'exécution, avec des
# erreurs DuckDB dans la console du navigateur et aucune trace côté build.
REQUIS=(
  "webapp/vendor/duckdb-wasm/duckdb-eh.wasm"
  "webapp/vendor/duckdb-wasm/extensions/v1.1.1/wasm_eh/parquet.duckdb_extension.wasm"
  "webapp/data/parquet/aggregat/data.parquet"
  "webapp/data/parquet/reference/reporters.parquet"
)
for fichier in "${REQUIS[@]}"; do
  if [ ! -s "${fichier}" ]; then
    echo "ERREUR : ${fichier} absent ou vide après extraction de l'archive." >&2
    echo "Vérifie que la release ${TAG} contient bien ${ARCHIVE} à jour." >&2
    exit 1
  fi
done

NB_PARQUET=$(find webapp/data/parquet -name '*.parquet' | wc -l)
echo "OK : ${NB_PARQUET} fichiers Parquet et le moteur DuckDB-WASM sont en place."
