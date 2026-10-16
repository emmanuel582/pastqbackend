import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { prepareImage } from '../services/vision/image.js';

describe('page image intake', () => {
  it('applies EXIF rotation and caps the long side', async () => {
    const input = await sharp({ create: { width: 6000, height: 3000, channels: 3, background: '#fff' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const { base } = await prepareImage(input);
    const meta = await sharp(base).metadata();
    assert.ok(Math.max(meta.width, meta.height) <= 4200);
    assert.ok(meta.height > meta.width, 'rotated to portrait');
  });

  it('rejects empty and non-image input', async () => {
    await assert.rejects(() => prepareImage(Buffer.alloc(0)), /empty/);
    await assert.rejects(() => prepareImage(Buffer.from('not an image at all')));
  });
});
