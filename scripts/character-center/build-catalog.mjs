import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CHARACTER_CATALOG } from '../../realtime/character-center/catalog.mjs';
const destination=fileURLToPath(new URL('../../realtime/character-center/catalog.json',import.meta.url));
export const compiledCatalogJSON=JSON.stringify(CHARACTER_CATALOG,null,2)+'\n';
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.includes('--check')) {
    if(await fs.readFile(destination,'utf8')!==compiledCatalogJSON)throw Error('Generated character catalog drift; run scripts/character-center/build-catalog.mjs');
  } else await fs.writeFile(destination,compiledCatalogJSON);
  console.log(JSON.stringify({hash:CHARACTER_CATALOG.hash,actions:CHARACTER_CATALOG.actions.length,...CHARACTER_CATALOG.coverage}));
}
