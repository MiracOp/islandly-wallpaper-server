import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { prepareImageVariants, withImageVariants } from '../image-variants.js';

test('small, versioned previews preserve originals and reuse generated files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'islandly-variants-'));
  try {
    await mkdir(join(root, 'media'));
    const original = await sharp({ create: { width: 1600, height: 2400, channels: 3, background: '#b79cff' } }).png().toBuffer();
    await writeFile(join(root, 'media', 'photo.png'), original);
    const item = { id: 'photo', imageURL: '/media/photo.png', partnerURL: '/media/photo.png', coupleCoverURL: '/media/photo.png' };
    const map = await prepareImageVariants([item, { imageURL: '/media/../../outside.png' }, { imageURL: 'https://example.com/photo.png' }], root);
    assert.equal(map.size, 1);
    const result = withImageVariants(item, map);
    assert.equal(result.imageURL, item.imageURL);
    assert.equal(result.partnerURL, item.partnerURL);
    assert.equal(result.cardThumbURL, result.coupleCoverURL);
    assert.equal(result.previewURL, result.partnerPreviewURL);
    const thumbPath = join(root, result.cardThumbURL);
    const thumb = await sharp(thumbPath).metadata();
    const preview = await sharp(join(root, result.previewURL)).metadata();
    assert.equal(Math.max(thumb.width, thumb.height), 640);
    assert.equal(Math.max(preview.width, preview.height), 1400);
    assert.equal(thumb.format, 'jpeg');
    assert.deepEqual(await readFile(join(root, 'media/photo.png')), original);
    const before = (await stat(thumbPath)).mtimeMs;
    const again = await prepareImageVariants([item], root);
    assert.equal(withImageVariants(item, again).cardThumbURL, result.cardThumbURL);
    assert.equal((await stat(thumbPath)).mtimeMs, before);
    const changed = await sharp(original).negate().png().toBuffer();
    await writeFile(join(root, 'media/photo.png'), changed);
    const updated = await prepareImageVariants([item], root);
    assert.notEqual(withImageVariants(item, updated).cardThumbURL, result.cardThumbURL);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('existing thumbnails and external original URLs remain usable without variants', () => {
  const item = { imageURL: 'https://example.com/original.jpg', thumbURL: 'https://example.com/thumb.jpg' };
  const result = withImageVariants(item, new Map());
  assert.equal(result.thumbURL, item.thumbURL);
  assert.equal(result.cardThumbURL, item.thumbURL);
  assert.equal(result.previewURL, item.imageURL);
});


test('widget thumbnails shrink originals and preserve transparency and encoded paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'islandly-widget-variants-'));
  try {
    await mkdir(join(root, 'media', 'widgets'), { recursive: true });
    const original = await sharp({ create: { width: 1800, height: 1200, channels: 4,
      background: { r: 120, g: 80, b: 200, alpha: 0.5 } } }).png().toBuffer();
    await writeFile(join(root, 'media', 'widgets', 'test image.png'), original);
    const source = '/media/widgets/test%20image.png';
    const variants = await prepareImageVariants([{ imageURL: source }], root);
    assert.equal(variants.get(source).width, 1800);
    assert.equal(variants.get(source).height, 1200);
    const metadata = await sharp(join(root, variants.get(source)[640])).metadata();
    assert.equal(metadata.width, 640);
    assert.equal(metadata.hasAlpha, true);
    assert.equal(metadata.format, 'webp');
    assert.deepEqual(await readFile(join(root, 'media', 'widgets', 'test image.png')), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
