#!/usr/bin/env python3
"""Render Soma's app icon from its geometry, on a transparent 1024px macOS canvas.

Geometry mirrors public/soma.svg (64-unit design grid): a rounded tile and three
rotated capsules. Drawing directly avoids thumbnail tools that placed the artwork
in a corner of an oversized canvas.
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "build-resources" / "icon-source-1024.png"
SIZE = 1024
SS = 4  # supersampling factor for smooth edges
CANVAS = SIZE * SS

# macOS app icons keep artwork inside an ~824px tile with a transparent margin.
TILE = 824
MARGIN = (SIZE - TILE) / 2
TILE_RADIUS = 185  # ~22.5% of tile, close to the system squircle proportion
DESIGN = 64.0
SCALE = TILE / DESIGN * SS

TILE_COLOR = (244, 245, 244, 255)
LOGO = (80, 105, 86)  # #506956

# (x, y, width, height, radius, opacity) on the 64-unit grid, before the -26 degree rotation.
CAPSULES = [
    (17, 23, 8, 25, 4, 0.78),
    (28, 13, 8, 37, 4, 1.00),
    (39, 18, 8, 27, 4, 0.57),
]
ROTATION = math.radians(-26)  # SVG rotate(-26 32 32)


def rounded_points(x, y, w, h, r, steps=18):
    """Outline of a rounded rectangle as a list of (x, y) in design units."""
    pts = []
    corners = [
        (x + w - r, y + r, -90, 0),
        (x + w - r, y + h - r, 0, 90),
        (x + r, y + h - r, 90, 180),
        (x + r, y + r, 180, 270),
    ]
    for cx, cy, a0, a1 in corners:
        for i in range(steps + 1):
            t = math.radians(a0 + (a1 - a0) * i / steps)
            pts.append((cx + r * math.cos(t), cy + r * math.sin(t)))
    return pts


def to_canvas(px, py):
    """Apply SVG rotate(-26 32 32), then map the 64-unit grid onto the tile."""
    dx, dy = px - 32.0, py - 32.0
    rx = 32.0 + dx * math.cos(ROTATION) - dy * math.sin(ROTATION)
    ry = 32.0 + dx * math.sin(ROTATION) + dy * math.cos(ROTATION)
    return (MARGIN * SS + rx * SCALE, MARGIN * SS + ry * SCALE)


def main() -> None:
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))

    tile = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle(
        [MARGIN * SS, MARGIN * SS, (MARGIN + TILE) * SS, (MARGIN + TILE) * SS],
        radius=TILE_RADIUS * SS,
        fill=TILE_COLOR,
    )
    canvas = Image.alpha_composite(canvas, tile)

    for x, y, w, h, r, opacity in CAPSULES:
        layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        polygon = [to_canvas(px, py) for px, py in rounded_points(x, y, w, h, r)]
        ImageDraw.Draw(layer).polygon(polygon, fill=(*LOGO, round(255 * opacity)))
        canvas = Image.alpha_composite(canvas, layer)

    final = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    final.save(OUT, "PNG")
    print(f"wrote {OUT} ({final.size[0]}x{final.size[1]}, mode {final.mode})")


if __name__ == "__main__":
    main()
