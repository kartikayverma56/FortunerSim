"""Build a standalone 3D preview (one HTML file) of a patch of Jaipur's walled city from OpenStreetMap data.

Usage: python -I tools/jaipur/build_preview.py <osm.json> <out.html>

- Projects lat/lon to local metres around Badi Chaupar (x east, z south).
- Roads: OSM highway ways with widths by class.
- Buildings: OSM footprints; height from building:levels/height, else from footprint area.
- Gap fill: along bazaar-class streets, where OSM has no building, adds Pink City shop rows (flagged 'fill').
Data: (c) OpenStreetMap contributors, ODbL 1.0.
"""
import json
import math
import sys

LAT0, LON0 = 26.92390, 75.82670  # Badi Chaupar
KX = math.cos(math.radians(LAT0)) * 111320.0
KZ = 110574.0

ROAD_W = {'trunk': 16, 'trunk_link': 9, 'primary': 14, 'primary_link': 8, 'secondary': 11, 'secondary_link': 7,
          'tertiary': 9, 'tertiary_link': 6, 'unclassified': 7, 'residential': 6, 'living_street': 5,
          'service': 4, 'pedestrian': 6, 'footway': 2.5, 'path': 2}
BAZAAR = {'trunk', 'primary', 'secondary', 'tertiary'}


def proj(lat, lon):
    return round((lon - LON0) * KX, 2), round(-(lat - LAT0) * KZ, 2)


def area(poly):
    s = 0.0
    for i in range(len(poly)):
        x1, z1 = poly[i]; x2, z2 = poly[(i + 1) % len(poly)]
        s += x1 * z2 - x2 * z1
    return abs(s) / 2


def inside(px, pz, poly):
    c = False; n = len(poly)
    for i in range(n):
        x1, z1 = poly[i]; x2, z2 = poly[(i + 1) % n]
        if (z1 > pz) != (z2 > pz) and px < (x2 - x1) * (pz - z1) / (z2 - z1 + 1e-12) + x1:
            c = not c
    return c


def main():
    src, out = sys.argv[1], sys.argv[2]
    d = json.load(open(src, encoding='utf-8'))
    nodes = {e['id']: (e['lat'], e['lon']) for e in d['elements'] if e['type'] == 'node' and 'lat' in e}
    ways = [e for e in d['elements'] if e['type'] == 'way']

    def pts(w):
        return [proj(*nodes[n]) for n in w.get('nodes', []) if n in nodes]

    roads, buildings, green, walls = [], [], [], []
    for w in ways:
        t = w.get('tags', {}); p = pts(w)
        if len(p) < 2:
            continue
        hw = t.get('highway')
        if hw in ROAD_W:
            wid = ROAD_W[hw]
            if 'width' in t:
                try: wid = float(str(t['width']).split()[0])
                except ValueError: pass
            roads.append({'c': hw, 'w': wid, 'n': t.get('name', ''), 'p': [c for xy in p for c in xy]})
        elif 'building' in t and len(p) >= 4:
            poly = p[:-1] if p[0] == p[-1] else p
            a = area(poly)
            if a < 6:
                continue
            h = None
            try:
                if 'height' in t: h = float(str(t['height']).split()[0])
                elif 'building:levels' in t: h = float(t['building:levels']) * 3.3
            except ValueError: h = None
            if h is None:
                h = 6.6 if a < 60 else 9.9 if a < 400 else 13.2
            buildings.append({'h': round(h, 1), 'n': t.get('name', ''), 'p': [c for xy in poly for c in xy]})
        elif (t.get('landuse') in ('grass', 'recreation_ground', 'village_green') or t.get('leisure') in ('park', 'garden')) and len(p) >= 4:
            green.append({'p': [c for xy in p for c in xy]})
        elif t.get('barrier') == 'city_wall':
            walls.append({'p': [c for xy in p for c in xy]})

    # gap fill along bazaar streets: Pink City shop rows where OSM has no building
    bpolys = [list(zip(b['p'][0::2], b['p'][1::2])) for b in buildings]
    bbox = [(min(x for x, _ in q), max(x for x, _ in q), min(z for _, z in q), max(z for _, z in q)) for q in bpolys]
    def occupied(x, z):
        for (x0, x1, z0, z1), q in zip(bbox, bpolys):
            if x0 - 1 <= x <= x1 + 1 and z0 - 1 <= z <= z1 + 1 and inside(x, z, q):
                return True
        return False
    rsegs = []
    for r in roads:
        p = list(zip(r['p'][0::2], r['p'][1::2]))
        for i in range(len(p) - 1):
            rsegs.append((p[i], p[i + 1], r['w'] / 2 + 0.8))
    def on_road(x, z):
        for (ax, az), (bx, bz), hw in rsegs:
            dx, dz = bx - ax, bz - az; L2 = dx * dx + dz * dz or 1
            t = max(0, min(1, ((x - ax) * dx + (z - az) * dz) / L2))
            if math.hypot(ax + t * dx - x, az + t * dz - z) < hw:
                return True
        return False
    fills = 0
    for r in roads:
        if r['c'] not in BAZAAR:
            continue
        p = list(zip(r['p'][0::2], r['p'][1::2]))
        for i in range(len(p) - 1):
            (ax, az), (bx, bz) = p[i], p[i + 1]
            L = math.hypot(bx - ax, bz - az)
            if L < 6:
                continue
            ux, uz = (bx - ax) / L, (bz - az) / L; nx, nz = -uz, ux
            seg = 9.0; k = 0
            while (k + 1) * seg <= L - 2:
                s0 = k * seg + 1; s1 = s0 + seg - 1.2
                for side in (1, -1):
                    off0 = r['w'] / 2 + 3.0  # arcade/footpath strip
                    depth = 11.0
                    cx = ax + ux * (s0 + s1) / 2 + nx * side * (off0 + depth / 2)
                    cz = az + uz * (s0 + s1) / 2 + nz * side * (off0 + depth / 2)
                    if occupied(cx, cz) or on_road(cx, cz):
                        continue
                    q = []
                    for (s, o) in ((s0, off0), (s1, off0), (s1, off0 + depth), (s0, off0 + depth)):
                        q.append((round(ax + ux * s + nx * side * o, 2), round(az + uz * s + nz * side * o, 2)))
                    if side < 0:
                        q.reverse()
                    if any(on_road(x, z) for x, z in q):
                        continue
                    h = 6.6 if (fills % 3) else 9.9
                    buildings.append({'h': h, 'n': '', 'f': 1, 'p': [c for xy in q for c in xy]})
                    bpolys.append(q); bbox.append((min(x for x, _ in q), max(x for x, _ in q), min(z for _, z in q), max(z for _, z in q)))
                    fills += 1
                k += 1

    # city wall: cut 4 m pieces and leave openings where a road passes through (the gates)
    pieces = []
    for w in walls:
        p = list(zip(w['p'][0::2], w['p'][1::2]))
        for i in range(len(p) - 1):
            (ax, az), (bx, bz) = p[i], p[i + 1]; L = math.hypot(bx - ax, bz - az); n = max(1, int(L // 4))
            for k in range(n):
                t0, t1 = k / n, (k + 1) / n
                x0, z0, x1, z1 = ax + (bx - ax) * t0, az + (bz - az) * t0, ax + (bx - ax) * t1, az + (bz - az) * t1
                if on_road((x0 + x1) / 2, (z0 + z1) / 2) or on_road(x0, z0) or on_road(x1, z1):
                    continue
                pieces.append({'p': [round(x0, 2), round(z0, 2), round(x1, 2), round(z1, 2)]})
    walls = pieces
    data = {'roads': roads, 'buildings': buildings, 'green': green, 'walls': walls}
    tpl = open(__file__.replace('build_preview.py', 'preview_template.html'), encoding='utf-8').read()
    html = tpl.replace('/*__DATA__*/null', json.dumps(data, separators=(',', ':')))
    open(out, 'w', encoding='utf-8').write(html)
    print(f"roads {len(roads)}, OSM buildings {len(buildings) - fills}, filled shop rows {fills}, green {len(green)}, walls {len(walls)}, html {len(html)/1e6:.2f} MB")


if __name__ == '__main__':
    main()
