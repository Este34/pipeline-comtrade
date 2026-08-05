# three.js (vendorisé, offline)

Build ESM minifié de **three.js r185.1**, servi en local comme le reste de
`vendor/` : aucun CDN au runtime, l'application reste utilisable hors ligne.

- `three.module.min.js` : point d'entrée (357 Ko)
- `three.core.min.js` : cœur, importé par le précédent (376 Ko)
- `LICENSE` : MIT, à conserver — c'est la condition de la redistribution

## Les deux fichiers sont indispensables

Depuis r165, `three.module.min.js` ne se suffit plus à lui-même : sa première
ligne est `import{…}from"./three.core.min.js"`. Ne copier que le premier donne
une erreur de résolution de module au premier `import()`, et rien d'autre — le
globe échoue silencieusement et retombe sur le diagramme SVG, ce qui peut
passer inaperçu longtemps.

## Poids mesuré

| Fichier | Brut | gzip | brotli |
|---|---|---|---|
| `three.module.min.js` | 357 Ko | 85 Ko | 71 Ko |
| `three.core.min.js` | 376 Ko | 100 Ko | 80 Ko |
| **Total** | **733 Ko** | **185 Ko** | **151 Ko** |

C'est la raison pour laquelle `webapp/js/globe.js` fait son `import()` **dans
la fonction** et non en tête de module : les onglets qui n'affichent pas de
globe ne téléchargent aucun de ces octets. Vercel sert ces fichiers compressés
et avec le `Cache-Control` d'un an déjà déclaré pour `/vendor/(.*)` dans
`vercel.json`.

## Remplacer la version

```bash
npm pack three@0.185.1            # ou la version visée
tar -xzf three-0.185.1.tgz
cp package/build/three.module.min.js package/build/three.core.min.js package/LICENSE .
```

Vérifier ensuite que la première ligne de `three.module.min.js` importe bien
`./three.core.min.js` et rien d'autre :

```bash
node -e "const s=require('fs').readFileSync('three.module.min.js','utf8');
console.log([...new Set([...s.matchAll(/from\s*[\"']([^\"']+)[\"']/g)].map(m=>m[1]))])"
```

Une version qui introduirait une dépendance supplémentaire casserait le
fonctionnement hors ligne sans erreur au build.
