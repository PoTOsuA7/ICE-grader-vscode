"""Draw extension/icon.png (128x128, the Marketplace size) with plain Python, no image libraries."""
import os
import struct
import zlib

N, SS = 128, 4  # size, supersampling per axis
TOP, BOTTOM = (43, 58, 103), (24, 32, 64)
CHECK = [(34, 66), (56, 88), (96, 40)]
WIDTH, RADIUS = 15, 26


def in_rounded_square(x, y):
    cx = min(max(x, RADIUS), N - RADIUS)
    cy = min(max(y, RADIUS), N - RADIUS)
    return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2


def near_segment(x, y, a, b):
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= (WIDTH / 2) ** 2


rows = []
for py in range(N):
    row = bytearray([0])  # PNG filter: none
    bg = [round(TOP[i] + (BOTTOM[i] - TOP[i]) * py / N) for i in range(3)]
    for px in range(N):
        cover = mark = 0
        for sy in range(SS):
            for sx in range(SS):
                x, y = px + (sx + 0.5) / SS, py + (sy + 0.5) / SS
                if in_rounded_square(x, y):
                    cover += 1
                    if any(near_segment(x, y, CHECK[i], CHECK[i + 1]) for i in range(len(CHECK) - 1)):
                        mark += 1
        if cover:
            k = mark / cover
            rgb = [round(bg[i] * (1 - k) + 255 * k) for i in range(3)]
        else:
            rgb = [0, 0, 0]
        row += bytes(rgb + [round(255 * cover / SS ** 2)])
    rows.append(bytes(row))


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)


png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 6, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b''))
out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'extension', 'icon.png')
open(out, 'wb').write(png)
print('wrote', out)
