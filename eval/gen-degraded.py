#!/usr/bin/env python3
"""Generate controlled degradations of sample portraits for the specificity test.

Each degradation targets ONE OnFrame category. The harness then checks the
target score drops while the others hold (sensitivity + specificity).

Usage: python3 eval/gen-degraded.py <out_dir>
Prints a JSON manifest [{file, base, label, target, direction}] to stdout.
"""
import sys, json, os
from PIL import Image, ImageEnhance, ImageFilter, ImageDraw

SAMPLE_DIR = os.path.join(os.path.dirname(__file__), '..', 'web', 'sample')

def load(name):
    return Image.open(os.path.join(SAMPLE_DIR, name)).convert('RGB')

def blur(img):                       # → Sharpness & Focus
    return img.filter(ImageFilter.GaussianBlur(radius=max(img.size) / 180))

def underexpose(img):                # → Lighting (detail-burying underexposure)
    return ImageEnhance.Brightness(img).enhance(0.35)

def overexpose(img):                 # → Lighting (blown highlights)
    return ImageEnhance.Brightness(img).enhance(1.95)

def offcenter(img):                  # → Composition & Framing (dead space + off-center)
    w, h = img.size
    canvas = Image.new('RGB', (int(w * 1.7), h), (235, 235, 235))
    canvas.paste(img, (int(w * 0.65), 0))   # subject jammed to the right edge
    return canvas

def busy_bg(img, clutter):           # → Background (clean bg → busy clutter)
    w, h = img.size
    clutter = clutter.resize((w, h))
    # Keep a central elliptical "subject" region from the original; replace the
    # surrounding background with high-contrast clutter.
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).ellipse([int(w*0.20), int(h*0.05), int(w*0.80), int(h*0.95)], fill=255)
    out = clutter.copy()
    out.paste(img, (0, 0), mask)
    return out

PLAN = [
    ('sample3.jpg', 'blur',        blur,        'Sharpness & Focus',     'down'),
    ('sample3.jpg', 'underexpose', underexpose, 'Lighting',              'down'),
    ('sample3.jpg', 'overexpose',  overexpose,  'Lighting',              'down'),
    ('sample3.jpg', 'offcenter',   offcenter,   'Composition & Framing', 'down'),
    ('sample6.jpg', 'blur',        blur,        'Sharpness & Focus',     'down'),
    ('sample4.jpg', 'busybg',      None,        'Background',            'down'),
]

def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    clutter = load('sample1.jpg')  # the US-flag shot = reliably busy
    manifest = []
    # baselines (deduped)
    for base in sorted({p[0] for p in PLAN}):
        load(base).save(os.path.join(out_dir, f'base_{base}'), quality=92)
    for base, label, fn, target, direction in PLAN:
        img = load(base)
        out = busy_bg(img, clutter) if label == 'busybg' else fn(img)
        fname = f'{label}_{base}'
        out.save(os.path.join(out_dir, fname), quality=92)
        manifest.append({'file': fname, 'base': f'base_{base}', 'label': f'{base}:{label}',
                         'target': target, 'direction': direction})
    print(json.dumps({'baselines': sorted({p[0] for p in PLAN}), 'variants': manifest}))

if __name__ == '__main__':
    main()
