import json, math, sys, collections

src = sys.argv[1]
out = sys.argv[2]
S, W, N, E = 13.0560, 77.5770, 13.0700, 77.5960
LAT0 = (S + N) / 2
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110574

def proj(lat, lon):
    return (round((lon - W) * KX), round((N - lat) * KY))

WIDTH, HEIGHT = proj(S, E)
roads = json.load(open(src + "/roads.json"))["elements"]
areas = json.load(open(src + "/areas.json"))["elements"]
pois = json.load(open(src + "/poi.json"))["elements"]

CLS = {"trunk": 0, "trunk_link": 0, "primary": 0, "secondary": 1, "tertiary": 2,
       "unclassified": 3, "residential": 3, "living_street": 3, "pedestrian": 3}
idx, nodes, ways = {}, [], []
M = 150
for w in roads:
    pts = []
    for g in w["geometry"]:
        x, y = proj(g["lat"], g["lon"])
        if not (-M <= x <= WIDTH + M and -M <= y <= HEIGHT + M):
            if len(pts) > 1:
                ways.append([w["tags"].get("name", ""), CLS.get(w["tags"]["highway"], 3), pts])
            pts = []
            continue
        k = (g["lat"], g["lon"])
        if k not in idx:
            idx[k] = len(nodes)
            nodes.append([x, y])
        i = idx[k]
        if not pts or pts[-1] != i:
            pts.append(i)
    if len(pts) > 1:
        ways.append([w["tags"].get("name", ""), CLS.get(w["tags"]["highway"], 3), pts])

# keep only the largest connected component so every route resolves
adj = collections.defaultdict(set)
for _, _, p in ways:
    for a, b in zip(p, p[1:]):
        adj[a].add(b); adj[b].add(a)
seen, best = set(), set()
for s in list(adj):
    if s in seen:
        continue
    comp, stack = set(), [s]
    while stack:
        u = stack.pop()
        if u in comp:
            continue
        comp.add(u); stack.extend(adj[u] - comp)
    seen |= comp
    if len(comp) > len(best):
        best = comp
ways = [w for w in ways if w[2][0] in best]
used = sorted({i for w in ways for i in w[2]})
remap = {o: n for n, o in enumerate(used)}
nodes = [nodes[o] for o in used]
ways = [[n, c, [remap[i] for i in p]] for n, c, p in ways]

def kind(t):
    if t.get("natural") == "water": return "water"
    if t.get("leisure") in ("park", "garden", "playground", "pitch") or t.get("landuse") in ("grass", "recreation_ground"): return "green"
    if t.get("amenity") == "place_of_worship": return "temple"
    if t.get("amenity") in ("school", "hospital", "clinic") or t.get("landuse") in ("education", "commercial"): return "inst"
    return None

polys = []
for a in areas:
    if a["type"] != "way" or "geometry" not in a:
        continue
    k = kind(a.get("tags", {}))
    if not k:
        continue
    pts = [proj(g["lat"], g["lon"]) for g in a["geometry"]]
    polys.append([k, [c for p in pts for c in p]])

def centre(e):
    if "lat" in e: return e["lat"], e["lon"]
    if "center" in e: return e["center"]["lat"], e["center"]["lon"]
    b = e.get("bounds")
    if b: return (b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2
    g = e.get("geometry")
    return sum(p["lat"] for p in g) / len(g), sum(p["lon"] for p in g) / len(g)

shops = []
for e in pois:
    t = e.get("tags", {})
    if "shop" in t or t.get("amenity") in ("restaurant", "cafe", "fast_food", "bank", "pharmacy"):
        x, y = proj(*centre(e))
        if 0 <= x <= WIDTH and 0 <= y <= HEIGHT:
            shops.append([x, y])
shops = [c for p in shops for c in p]

WANT = {
    "Iyengar's Bakery & Sweets": ("bakery", "Bk"),
    "Ganga bakes": ("bakery", "Bk"),
    "Apollo Pharmacy": ("pharmacy", "Rx"),
    "Mediplus Medical Store": ("pharmacy", "Rx"),
    "HOPCOMS": ("shop", "Hp"),
    "Sahakaranagara Post Office": ("post", "Po"),
    "Sahakarnagar C Block Park": ("park", "Pk"),
    "Temple park": ("park", "Pk"),
    "Sahakara Nagar CQAL Kids Park": ("park", "Pk"),
    "Ganesha Temple": ("temple", "Om"),
    "Sri Kodandaramaswamy Temple": ("temple", "Om"),
    "Sri Gundanjaneya Swami Temple": ("temple", "Om"),
    "Swamy Ayappa Temple": ("temple", "Om"),
    "MEDSTAR Speciality Hospital": ("hospital", "H"),
    "Manipal Hospital OPD": ("hospital", "H"),
    "Kodigehalli Gate": ("bus", "Bus"),
    "Byatarayanapura": ("bus", "Bus"),
    "Maruthi Nagara": ("bus", "Bus"),
    "Third Wave Coffee Roasters": ("cafe", "Cf"),
}
lms, taken = [], set()
for e in pois + areas:
    t = e.get("tags", {})
    n = t.get("name")
    if n not in WANT or n in taken:
        continue
    if n in ("Byatarayanapura", "Maruthi Nagara") and t.get("highway") != "bus_stop":
        continue
    taken.add(n)
    lat, lon = centre(e)
    x, y = proj(lat, lon)
    k, g = WANT[n]
    label = n + (" bus stop" if k == "bus" else "")
    lms.append({"name": label, "k": k, "g": g, "x": x, "y": y, "lat": round(lat, 6), "lon": round(lon, 6)})

places = []
for e in pois:
    t = e.get("tags", {})
    if t.get("place") in ("suburb", "neighbourhood") and t.get("name"):
        x, y = proj(e["lat"], e["lon"])
        places.append([t["name"], x, y])

data = {"w": WIDTH, "h": HEIGHT, "bbox": [S, W, N, E], "kx": KX, "ky": KY,
        "nodes": [c for p in nodes for c in p], "ways": ways, "polys": polys,
        "shops": shops, "lms": lms, "places": places}
json.dump(data, open(out, "w"), separators=(",", ":"))
print(WIDTH, HEIGHT, "nodes", len(nodes), "ways", len(ways), "polys", len(polys), "lms", len(lms), "shops", len(shops) // 2)
print([l["name"] for l in lms])
print(sorted({w[0] for w in ways if w[1] <= 1}))
