import { api } from './api';

const cache = new Map<string, string>();

/** Average "vibrant" color of a cover image, as an `r, g, b` string (for CSS rgba()). */
export async function dominantColor(thumb: string | null | undefined): Promise<string | null> {
  if (!thumb) return null;
  if (cache.has(thumb)) return cache.get(thumb)!;
  // Same-origin images (blob:, data:, our own /api/… such as radio logos) need no proxy.
  const src = thumb.startsWith('blob:') || thumb.startsWith('data:') || thumb.startsWith('/') ? thumb : api.imageUrl(thumb);
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 24, 24);
    const { data } = ctx.getImageData(0, 0, 24, 24);
    let r = 0; let g = 0; let b = 0; let w = 0;
    for (let i = 0; i < data.length; i += 4) {
      const max = Math.max(data[i], data[i + 1], data[i + 2]);
      const min = Math.min(data[i], data[i + 1], data[i + 2]);
      // Weight saturated, mid-bright pixels higher so the result is not a muddy grey.
      const weight = (max - min + 16) * (max > 30 && max < 245 ? 1 : 0.2);
      r += data[i] * weight; g += data[i + 1] * weight; b += data[i + 2] * weight; w += weight;
    }
    if (!w) return null;
    const color = `${Math.round(r / w)}, ${Math.round(g / w)}, ${Math.round(b / w)}`;
    cache.set(thumb, color);
    return color;
  } catch {
    return null;
  }
}
