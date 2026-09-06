import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareImageVariants } from '../image-variants.js';
const root = new URL('../', import.meta.url);
const items = JSON.parse(await readFile(new URL('data/wallpapers.json', root), 'utf8'));
const variants = await prepareImageVariants(items, fileURLToPath(new URL('public', root)));
console.log(`Prepared previews for ${variants.size} images`);
