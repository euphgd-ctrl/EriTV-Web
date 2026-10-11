from pathlib import Path
from urllib.request import urlopen
from io import BytesIO
import cairosvg
from PIL import Image

SOURCE = 'https://upload.wikimedia.org/wikipedia/commons/e/e4/Flag_of_Eritrea_%283-2%29.svg'
svg = urlopen(SOURCE, timeout=25).read()
assert b'<svg' in svg
Path('icons').mkdir(exist_ok=True)
for name, size in [('icon-192.png', 192), ('icon-512.png', 512), ('apple-touch-icon.png', 180), ('favicon-32.png', 32)]:
    height = round(size * 2 / 3)
    data = cairosvg.svg2png(bytestring=svg, output_width=size, output_height=height)
    flag = Image.open(BytesIO(data)).convert('RGBA')
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 255))
    canvas.alpha_composite(flag, (0, (size - height) // 2))
    canvas.convert('RGB').save('icons/' + name, 'PNG', optimize=True)
