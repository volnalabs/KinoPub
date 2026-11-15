#!/usr/bin/env python3
"""Генерирует app/icon.png — иконку Smart Hub (512x423, PNG, без прозрачности)."""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

W, H, SS = 512, 423, 4          # размер Samsung TV и коэффициент сглаживания
w, h = W * SS, H * SS


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(len(a)))


# Фон: вертикальный градиент + мягкое голубое свечение по центру
bg = Image.new('RGB', (w, h))
top, bottom = (16, 30, 62), (6, 9, 20)
px = bg.load()
cx, cy = w / 2, h * 0.47
for y in range(h):
    base = lerp(top, bottom, y / (h - 1))
    for x in range(w):
        d = math.hypot((x - cx) / (w * 0.55), (y - cy) / (h * 0.62))
        g = max(0.0, 1.0 - d) ** 2.2
        px[x, y] = lerp(base, (46, 104, 230), g * 0.8)

# Кнопка: круг с диагональным градиентом
r = int(h * 0.30)
grad = Image.new('RGB', (2 * r, 2 * r))
gp = grad.load()
c1, c2 = (64, 140, 255), (99, 82, 236)
for y in range(2 * r):
    for x in range(2 * r):
        gp[x, y] = lerp(c1, c2, (x + y) / (4 * r - 2))
mask = Image.new('L', (2 * r, 2 * r), 0)
ImageDraw.Draw(mask).ellipse([0, 0, 2 * r - 1, 2 * r - 1], fill=255)

# Тень под кнопкой
shadow = Image.new('L', (w, h), 0)
ImageDraw.Draw(shadow).ellipse([cx - r, cy - r + 10 * SS, cx + r, cy + r + 10 * SS], fill=90)
shadow = shadow.filter(ImageFilter.GaussianBlur(18 * SS))
bg = Image.composite(Image.new('RGB', (w, h), (2, 4, 10)), bg, shadow)
bg.paste(grad, (int(cx - r), int(cy - r)), mask)

d = ImageDraw.Draw(bg)
# Тонкое светлое кольцо вокруг кнопки
ring = int(r * 1.16)
d.ellipse([cx - ring, cy - ring, cx + ring, cy + ring], outline=(120, 170, 255), width=3 * SS)

# Треугольник «Play» со скруглёнными углами (смещён вправо для оптического центра)
tri_r = r * 0.5
ox = cx + r * 0.09
pts = [(ox + tri_r * math.cos(a), cy + tri_r * math.sin(a)) for a in (0, 2 * math.pi / 3, 4 * math.pi / 3)]
rad = 9 * SS
d.polygon(pts, fill=(255, 255, 255))
d.line(pts + [pts[0]], fill=(255, 255, 255), width=rad * 2, joint='curve')
for x, y in pts:
    d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=(255, 255, 255))

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'icon.png')
bg.resize((W, H), Image.LANCZOS).save(out, optimize=True)
print('icon:', os.path.normpath(out), Image.open(out).size)
