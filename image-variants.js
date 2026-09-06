import { createHash } from 'node:crypto';
import { mkdir, readFile, access, rename, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import sharp from 'sharp';

// Generate once at startup, then serve ordinary immutable static files.
// There is no image transformation or remote fetch on the request path.
export async function prepareImageVariants(items, publicDir) {
  const variants = new Map();
  const sources = new Set(['/media/couples-theme-cover.png']);
  for (const item of items) {
    for (const key of ['imageURL', 'stillURL', 'partnerURL', 'coupleCoverURL']) {
      if (item[key]) sources.add(item[key]);
    }
  }
  const mediaRoot = resolve(publicDir, 'media');
  const outputDir = resolve(mediaRoot, 'previews');
  await mkdir(outputDir, { recursive: true });
  // Keep decoding memory bounded even with a large library.
  const pending = [...sources];
  async function worker() {
    while (pending.length) {
      const source = pending.shift();
      if (!source.startsWith('/media/') || !/\.(png|jpe?g|webp|gif)$/i.test(source)) continue;
      let file;
      try { file = resolve(publicDir, '.' + decodeURIComponent(source)); } catch { continue; }
      if (!file.startsWith(mediaRoot + sep)) continue;
      try {
        const data = await readFile(file);
        const digest = createHash('sha256').update(data).digest('hex').slice(0, 24);
        const metadata = await sharp(data).metadata();
        const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation);
        const urls = {
          width: swapsAxes ? metadata.height : metadata.width,
          height: swapsAxes ? metadata.width : metadata.height
        };
        for (const size of [640, 1400]) {
          const isWidget = source.startsWith('/media/widgets/');
          const name = isWidget ? `${digest}-${size}-widget-v1.webp` : `${digest}-${size}-v1.jpg`;
          const destination = resolve(outputDir, name);
          try { await access(destination); } catch {
            const resized = sharp(data, { limitInputPixels: 40_000_000 })
              .rotate()
              .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true });
            const image = await (isWidget
              ? resized.webp({ quality: 82 })
              : resized.flatten({ background: '#050507' }).jpeg({ quality: size === 640 ? 78 : 86, mozjpeg: true }))
              .toBuffer();
            // Publish only complete files. Hash names invalidate stale device caches.
            const temp = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
            await writeFile(temp, image);
            await rename(temp, destination);
          }
          urls[size] = `/media/previews/${name}`;
        }
        variants.set(source, urls);
      } catch (error) {
        // Missing/unsupported media keeps its original URL and remains accessible.
        if (error.code !== 'ENOENT') console.warn('Preview generation skipped:', source, error.message);
      }
    }
  }
  await Promise.all([worker(), worker()]);
  return variants;
}

export function withImageVariants(item, variants) {
  const still = item.stillURL || item.imageURL;
  const cover = item.coupleCoverURL || '/media/couples-theme-cover.png';
  const cardSource = item.partnerURL ? cover : item.imageURL;
  return {
    ...item,
    thumbURL: item.thumbURL || variants.get(item.imageURL)?.[640] || '',
    cardThumbURL: (item.partnerURL ? variants.get(cardSource)?.[640] : item.thumbURL || variants.get(cardSource)?.[640]) || '',
    previewURL: variants.get(still)?.[1400] || still,
    partnerPreviewURL: variants.get(item.partnerURL)?.[1400] || item.partnerURL || '',
    // Older app versions also benefit from smaller Couples gallery covers.
    coupleCoverURL: item.partnerURL ? variants.get(cover)?.[640] || item.coupleCoverURL || '' : item.coupleCoverURL || ''
  };
}
