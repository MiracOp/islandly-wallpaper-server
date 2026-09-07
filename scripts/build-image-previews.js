import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareImageVariants } from '../image-variants.js';
const root = new URL('../', import.meta.url);
const items = JSON.parse(await readFile(new URL('data/wallpapers.json', root), 'utf8'));
const widgetFiles = await readdir(new URL('public/media/widgets', root)).catch(() => []);
const widgets = widgetFiles
  .filter((file) => /\.(png|jpe?g|webp|gif)$/i.test(file))
  .map((file, index) => ({
    id: `widget-preview-${index + 1}`,
    imageURL: `/media/widgets/${encodeURIComponent(file)}`
  }));
const variants = await prepareImageVariants([...items, ...widgets], fileURLToPath(new URL('public', root)));
console.log(`Prepared previews for ${variants.size} images`);
