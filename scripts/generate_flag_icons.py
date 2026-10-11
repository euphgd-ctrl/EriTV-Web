"""Render exact Eritrean national flag from the vendored source SVG.

Source: hampusborgos/country-flags svg/er.svg (2:1 proportions).
Flag geometry and the gold olive wreath are never redrawn or stretched.
"""
from io import BytesIO
from pathlib import Path
import cairosvg
from PIL import Image

svg = Path('icons/eritrea-official.svg').read_bytes()
assert b'<svg' in svg and b'#ffc72c' in svg
for name, size in [('icon-192.png', 192), ('icon-512.png', 512),
                   ('apple-touch-icon.png', 180), ('favicon-32.png', 32)]:
    height = size // 2  # flag source has exact 2:1 aspect ratio
    png = cairosvg.svg2png(bytestring=svg, output_width=size, output_height=height)
    flag = Image.open(BytesIO(png)).convert('RGBA')
    icon = Image.new('RGBA', (size, size), (0, 0, 0, 255))
    icon.alpha_composite(flag, (0, (size - height) // 2))
    icon.convert('RGB').save('icons/' + name, 'PNG', optimize=True)
    print('Rendered official flag:', name)
