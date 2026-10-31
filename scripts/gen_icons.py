#!/usr/bin/env python3
"""Generate TrTree icons (RGBA, fnOS 18.75% corner radius) with pure PIL."""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SS = 4  # supersample factor
CANVAS = 256

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def make_icon(size: int) -> Image.Image:
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # diagonal gradient background
    c1, c2 = (10, 22, 40), (18, 61, 100)
    grad = Image.new("RGBA", (S, S))
    px = grad.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            r, g, b = lerp(c1, c2, t)
            px[x, y] = (r, g, b, 255)
    mask = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(mask)
    radius = int(size * 0.1875) * SS
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    draw = ImageDraw.Draw(img)
    # subtle inner highlight
    draw.rounded_rectangle(
        [int(S * 0.012), int(S * 0.012), S - int(S * 0.012), S - int(S * 0.012)],
        radius=radius - int(S * 0.012), outline=(255, 255, 255, 26), width=max(1, int(S * 0.004)),
    )

    # treemap mosaic (inset 20%)
    x0 = int(S * 0.20); y0 = int(S * 0.20); x1 = S - x0; y1 = S - y0
    gap = int(S * 0.022)
    r = int(S * 0.030)
    def tile(a, b, c, d, color):
        draw.rounded_rectangle([a + gap, b + gap, c - gap, d - gap], radius=r, fill=color)
    mx = x0 + int((x1 - x0) * 0.56)
    my = y0 + int((y1 - y0) * 0.46)
    tile(x0, y0, mx, y1, (34, 211, 238, 255))          # cyan, tall left
    tile(mx, y0, x1, my, (59, 130, 246, 255))           # blue, top right
    bx = mx + int((x1 - mx) * 0.52)
    tile(mx, my, bx, y1, (245, 158, 11, 255))           # amber, bottom left
    tile(bx, my, x1, y1, (167, 139, 250, 255))          # violet, bottom right
    # small light accent inside the blue tile
    ax = mx + int((x1 - mx) * 0.14)
    ay = y0 + int((my - y0) * 0.18)
    tile(ax, ay, ax + int((x1 - mx) * 0.30), ay + int((my - y0) * 0.28), (226, 240, 255, 235))

    img = img.resize((size, size), Image.LANCZOS)
    return img

def main():
    for size, out in [
        (256, os.path.join(ROOT, "packaging", "ICON_256.PNG")),
        (64, os.path.join(ROOT, "packaging", "ICON.PNG")),
        (256, os.path.join(ROOT, "packaging", "app", "ui", "images", "icon_256.png")),
        (128, os.path.join(ROOT, "packaging", "app", "ui", "images", "icon_128.png")),
        (64, os.path.join(ROOT, "packaging", "app", "ui", "images", "icon_64.png")),
        (256, os.path.join(ROOT, "docs", "icon.png")),
    ]:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        make_icon(size).save(out, "PNG")
        print("wrote", out)

if __name__ == "__main__":
    main()
