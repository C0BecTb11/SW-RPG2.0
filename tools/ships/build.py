#!/usr/bin/env python3
# Сборка внутренностей кораблей 2.0 из силуэта спрайта карты и плана отсеков.
#   python3 tools/ships/build.py            — собрать shared/ships/*.json
#   python3 tools/ships/build.py --png DIR  — ещё и картинки для проверки
#
# Силуэт берётся из того же спрайта, что на космической карте (assets/ships),
# поэтому снаружи и внутри корабль один и тот же. Клетка = 2 м, длина — по
# канону. Всё внутри корпуса, что не комната и не коридор, — техпространство.

import json, os, sys, math
from collections import deque
import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.dirname(__file__))
from specs import SHIPS

CELL_M = 2           # метров в клетке боя
K = 2                # план в клетках по 4 м → клетки по 2 м

VOID, TECH, HULL, WALL, FLOOR, DOOR = 0, 1, 2, 3, 4, 5
# Предметы: 1 — укрытие (через него стреляют), 2 — глухой предмет
COVER, BLOCK = 1, 2

DOOR_MAX = {'hangar': 4, 'troops': 3, 'vehicle': 3, 'engine': 3, 'hold': 3, 'droids': 3, 'dock': 2}


def hull_mask(ship_id, length_m):
    im = Image.open(os.path.join(ROOT, 'assets', 'ships', ship_id + '.png')).convert('RGBA')
    a = np.array(im)[:, :, 3]
    ys, xs = np.where(a > 40)
    crop = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    im = im.crop(crop)
    H = round(length_m / CELL_M)
    W = round(im.width * H / im.height)
    al = np.array(im.getchannel('A').resize((W, H), Image.BOX)).astype(np.int32)
    inside = al > 110
    # дыры в спрайте (прозрачные пиксели внутри корпуса) — заливаем
    out = np.zeros_like(inside); q = deque()
    for x in range(W):
        for y in (0, H - 1):
            if not inside[y, x] and not out[y, x]: out[y, x] = True; q.append((x, y))
    for y in range(H):
        for x in (0, W - 1):
            if not inside[y, x] and not out[y, x]: out[y, x] = True; q.append((x, y))
    while q:
        x, y = q.popleft()
        for nx, ny in neighbors4(x, y, W, H):
            if not inside[ny, nx] and not out[ny, nx]: out[ny, nx] = True; q.append((nx, ny))
    return ~out, crop, W, H


def neighbors4(x, y, W, H):
    if x > 0: yield x - 1, y
    if x < W - 1: yield x + 1, y
    if y > 0: yield x, y - 1
    if y < H - 1: yield x, y + 1


def build(ship_id, spec):
    inside, crop, W, H = hull_mask(ship_id, spec['length_m'])
    kind = np.full((H, W), VOID, np.uint8)
    kind[inside] = TECH
    room = np.zeros((H, W), np.int32)       # номер комнаты + 1

    # обшивка: внутренние клетки, касающиеся пустоты (2 клетки = 4 м)
    hull = np.zeros_like(inside)
    for _ in range(2):
        edge = inside & ~hull
        pad = np.pad(inside & ~hull, 1, constant_values=False)
        touch = ~(pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:])
        hull |= edge & touch
    kind[hull] = HULL

    rooms = []
    for (rtype, name, x, y, w, h) in spec['rooms']:
        x0, y0, x1, y1 = x * K, y * K, (x + w) * K, (y + h) * K
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(W, x1), min(H, y1)
        sub = (kind[y0:y1, x0:x1] == TECH) & (room[y0:y1, x0:x1] == 0)
        if sub.sum() < 16:
            print('  ! комната вне корпуса:', name); continue
        n = len(rooms) + 1
        reg = np.zeros((H, W), bool); reg[y0:y1, x0:x1] = sub
        room[reg] = n
        pad = np.pad(reg, 1, constant_values=False)
        inner = reg & pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:]
        kind[reg] = WALL
        kind[inner] = FLOOR
        ys_, xs_ = np.where(inner)
        rooms.append({'n': n, 't': rtype, 'name': name, 'x': x0, 'y': y0, 'w': x1 - x0, 'h': y1 - y0,
                      'cx': round(float(xs_.mean()) + 0.5, 1), 'cy': round(float(ys_.mean()) + 0.5, 1),
                      'area': int(inner.sum())})
    by_name = {r['name']: r for r in rooms}

    for (x, y, w, h) in spec['corridors']:
        x0, y0, x1, y1 = x * K, y * K, (x + w) * K, (y + h) * K
        x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(W, x1), min(H, y1)
        sub = kind[y0:y1, x0:x1]
        sub[(sub == TECH)] = FLOOR

    auto_rooms(spec, rooms, kind, room, W, H)
    by_name = {r['name']: r for r in rooms}

    doors = []

    def wall_runs(r):
        """Клетки стены комнаты r, за которыми (поперёк стены) — проходимый пол не этой комнаты"""
        n = r['n']; cands = []
        for y in range(r['y'], r['y'] + r['h']):
            for x in range(r['x'], r['x'] + r['w']):
                if room[y, x] != n or kind[y, x] != WALL: continue
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ix, iy, ox, oy = x - dx, y - dy, x + dx, y + dy
                    if not (0 <= ix < W and 0 <= iy < H and 0 <= ox < W and 0 <= oy < H): continue
                    if kind[iy, ix] == FLOOR and room[iy, ix] == n:
                        if kind[oy, ox] in (FLOOR, DOOR) and room[oy, ox] != n:
                            cands.append((x, y, dx, dy, None))
                        elif kind[oy, ox] == WALL and room[oy, ox] != n:
                            fx, fy = ox + dx, oy + dy   # двойная стена между двумя комнатами
                            if 0 <= fx < W and 0 <= fy < H and kind[fy, fx] == FLOOR and room[fy, fx] == room[oy, ox]:
                                cands.append((x, y, dx, dy, (ox, oy)))
        return cands

    def open_door(x, y, dx, dy, far):
        # проём 2 клетки (4 м) вдоль стены
        ax, ay = (0, 1) if dx else (1, 0)
        cells = [(x, y), (x + ax, y + ay)]
        if far: cells += [(far[0], far[1]), (far[0] + ax, far[1] + ay)]
        for cx, cy in cells:
            if not (0 <= cx < W and 0 <= cy < H) or kind[cy, cx] != WALL: return False
        for cx, cy in cells: kind[cy, cx] = DOOR
        doors.append({'x': x, 'y': y, 'v': 1 if dx else 0, 'w': 2, 'd': 2 if far else 1})
        return True

    for r in rooms:
        cands = wall_runs(r)
        if not cands: continue
        # группы по стороне стены; на каждую сторону — проём ближе к середине
        sides = {}
        for c in cands: sides.setdefault((c[2], c[3]), []).append(c)
        limit = DOOR_MAX.get(r['t'], 2)
        order = sorted(sides.values(), key=lambda g: -len(g))
        made = 0
        for g in order:
            if made >= limit: break
            mx = sum(c[0] for c in g) / len(g); my = sum(c[1] for c in g) / len(g)
            g.sort(key=lambda c: abs(c[0] - mx) + abs(c[1] - my))
            for c in g:
                if open_door(*c): made += 1; break

    # связность: от самого большого куска пола; недостижимые комнаты — прокладываем ход
    def reach(start_cells):
        seen = np.zeros((H, W), bool); q = deque(start_cells)
        for sx, sy in start_cells: seen[sy, sx] = True
        while q:
            x, y = q.popleft()
            for nx, ny in neighbors4(x, y, W, H):
                if not seen[ny, nx] and kind[ny, nx] in (FLOOR, DOOR):
                    seen[ny, nx] = True; q.append((nx, ny))
        return seen

    def components():
        seen = np.zeros((H, W), bool); comps = []
        for y in range(H):
            for x in range(W):
                if kind[y, x] in (FLOOR, DOOR) and not seen[y, x]:
                    c = reach([(x, y)]); seen |= c; comps.append(c)
        return comps

    for _ in range(40):
        comps = components()
        if len(comps) <= 1: break
        comps.sort(key=lambda c: -int(c.sum()))
        main, other = comps[0], comps[1]
        # кратчайший путь из other в main через техпространство и стены
        prev = {}; q = deque()
        ys_, xs_ = np.where(other)
        for x, y in zip(xs_, ys_): prev[(int(x), int(y))] = None; q.append((int(x), int(y)))
        hit = None
        while q and hit is None:
            x, y = q.popleft()
            for nx, ny in neighbors4(x, y, W, H):
                if (nx, ny) in prev: continue
                k = kind[ny, nx]
                if k in (VOID, HULL): continue
                prev[(nx, ny)] = (x, y)
                if main[ny, nx]: hit = (nx, ny); break
                q.append((nx, ny))
        if hit is None: print('  ! не связать кусок пола'); break
        p = prev[hit]; path = []
        while p is not None and not other[p[1], p[0]]:
            path.append(p); p = prev[p]
        for (x, y) in path:
            if kind[y, x] == WALL: kind[y, x] = DOOR; doors.append({'x': x, 'y': y, 'v': 0, 'w': 1, 'd': 1, 'dug': 1})
            elif kind[y, x] == TECH:
                kind[y, x] = FLOOR
                # ход шириной 2 клетки там, где можно
                for nx, ny in ((x + 1, y), (x, y + 1)):
                    if 0 <= nx < W and 0 <= ny < H and kind[ny, nx] == TECH: kind[ny, nx] = FLOOR

    props = place_props(spec, rooms, kind, room, W, H)

    # орудия на корпусе
    mounts = []
    for (x, y, t, rname) in spec.get('mounts', []):
        r = by_name.get(rname)
        mounts.append({'x': x * K + 1, 'y': y * K + 1, 't': t, 'room': r['n'] if r else 0})

    for r in rooms:
        if r['t'] != 'pdgun': continue
        # турель ПВО — на ближайшей к комнате обшивке
        best = None
        cx, cy = int(r['cx']), int(r['cy'])
        for rad in range(1, 40):
            for dy in range(-rad, rad + 1):
                for dx in (-rad, rad) if abs(dy) != rad else range(-rad, rad + 1):
                    x, y = cx + dx, cy + dy
                    if 0 <= x < W and 0 <= y < H and kind[y, x] == HULL: best = (x, y); break
                if best: break
            if best: break
        if best: mounts.append({'x': best[0], 'y': best[1], 't': 'pd', 'room': r['n']})

    def rle(a):
        flat = a.ravel().tolist(); out = []; prevv = flat[0]; cnt = 0
        for v in flat:
            if v == prevv: cnt += 1
            else: out += [prevv, cnt]; prevv = v; cnt = 1
        out += [prevv, cnt]
        return out

    return {
        'id': ship_id, 'name': spec['name'], 'faction': spec['faction'], 'length_m': spec['length_m'],
        'cell_m': CELL_M, 'w': W, 'h': H, 'sprite': 'assets/ships/%s.png' % ship_id, 'crop': list(crop),
        'kind': rle(kind), 'room': rle(room), 'rooms': rooms, 'doors': doors, 'props': props, 'mounts': mounts,
    }, kind, room


# ---------------------------------------------------------------- добивка
AUTO = {
    'republic': [('quarters', 'Кубрик'), ('storage', 'Склад'), ('workshop', 'Мастерская'), ('quarters', 'Кубрик'),
                 ('armory', 'Оружейная'), ('mess', 'Кают-компания'), ('storage', 'Кладовая')],
    'cis':      [('droids', 'Стеллажи дроидов'), ('hold', 'Трюм'), ('storage', 'Склад'), ('droids', 'Стеллажи дроидов'),
                 ('workshop', 'Ремонт дроидов'), ('hold', 'Трюм')],
}

def largest_rect(free):
    H, W = free.shape; best = (0, 0, 0, 0, 0)
    h = np.zeros(W, np.int32)
    for y in range(H):
        h = np.where(free[y], h + 1, 0)
        st = []
        for x in range(W + 1):
            cur = h[x] if x < W else 0
            start = x
            while st and st[-1][1] >= cur:
                sx, sh = st.pop()
                w = x - sx; hh = min(sh, 60); ww = min(w, 60)
                if hh >= 10 and ww >= 10 and ww * hh > best[0]:
                    best = (int(ww * hh), int(sx), int(y - sh + 1), int(ww), int(hh))
                start = sx
            st.append((start, cur))
    return best


def auto_rooms(spec, rooms, kind, room, W, H):
    """Свободное техпространство — во вспомогательные отсеки: кубрики, склады,
    посты ПВО у обшивки. Часть остаётся техпространством (трубы, машины)."""
    tech = kind == TECH
    pad = np.pad(tech, 1, constant_values=False)
    free = tech & pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:]
    hullnear = np.zeros_like(tech)
    hp = np.pad(kind == HULL, 4, constant_values=False)
    for dy in range(-4, 5):
        for dx in range(-4, 5):
            hullnear |= hp[4 + dy:4 + dy + H, 4 + dx:4 + dx + W]
    pool = AUTO[spec['faction']]; k = 0; pd = 0
    for _ in range(int(spec.get('auto', 40))):
        area, x, y, w, h = largest_rect(free)
        if area < 150: break
        # большой кусок — не одной комнатой: режем до ~36×36
        w = min(w, 36); h = min(h, 36)
        sub = (kind[y:y + h, x:x + w] == TECH)
        n = len(rooms) + 1
        near = hullnear[y:y + h, x:x + w].any()
        if near and pd % 2 == 0 and w * h < 500:
            t, name = 'pdgun', 'Пост ПВО'
        else:
            t, name = pool[k % len(pool)]; k += 1
        if near: pd += 1
        reg = np.zeros((H, W), bool); reg[y:y + h, x:x + w] = sub
        room[reg] = n
        rp = np.pad(reg, 1, constant_values=False)
        inner = reg & rp[:-2, 1:-1] & rp[2:, 1:-1] & rp[1:-1, :-2] & rp[1:-1, 2:]
        kind[reg] = WALL; kind[inner] = FLOOR
        ys_, xs_ = np.where(inner)
        same = sum(1 for r in rooms if r['name'].startswith(name))
        rooms.append({'n': n, 't': t, 'name': name + ' ' + str(same + 1), 'x': x, 'y': y, 'w': w, 'h': h,
                      'cx': round(float(xs_.mean()) + 0.5, 1), 'cy': round(float(ys_.mean()) + 0.5, 1),
                      'area': int(inner.sum()), 'auto': 1})
        # зазор в 3 клетки вокруг — там останутся трубы и проходы
        free[max(0, y - 3):y + h + 3, max(0, x - 3):x + w + 3] = False


# Малые корабли по сторонам: (картинка, размер рамки в клетках по 2 м)
CRAFT = {
    'republic': [('arc170', 12), ('ywing', 12)],
    'cis':      [('vulture', 5), ('hyena', 6)],
}

# ---------------------------------------------------------------- мебель
def place_props(spec, rooms, kind, room, W, H):
    rep = spec['faction'] == 'republic'
    props = []

    def free(x, y, w, h, n, margin=1):
        if x - margin < 0 or y - margin < 0 or x + w + margin > W or y + h + margin > H: return False
        blk = kind[y - margin:y + h + margin, x - margin:x + w + margin]
        rm = room[y - margin:y + h + margin, x - margin:x + w + margin]
        return bool(((blk == FLOOR) & (rm == n)).all())

    def put(t, x, y, w, h, solid, n, margin=1, **kw):
        if not free(x, y, w, h, n, margin): return False
        p = {'t': t, 'x': x, 'y': y, 'w': w, 'h': h, 's': solid}
        p.update(kw); props.append(p)
        kind_mark = 6 + solid    # временная пометка: 7 — укрытие, 8 — глухое
        kind[y:y + h, x:x + w] = kind_mark
        return True

    def grid(n, r, t, w, h, gx, gy, solid, margin=1, **kw):
        y = r['y'] + 2
        while y + h <= r['y'] + r['h'] - 2:
            x = r['x'] + 2
            while x + w <= r['x'] + r['w'] - 2:
                put(t, x, y, w, h, solid, n, margin, **kw)
                x += w + gx
            y += h + gy

    def along_walls(n, r, t, size, step, solid):
        # консоли по периметру: вплотную к стене (поле без отступа к стене)
        for x in range(r['x'] + 2, r['x'] + r['w'] - 2 - size, step):
            for y, f in ((r['y'] + 1, 0), (r['y'] + r['h'] - 1 - 1, 2)):
                if ((kind[y, x:x + size] == FLOOR) & (room[y, x:x + size] == n)).all() and not (kind[y + (1 if f == 0 else -1), x:x + size] == 5).any():
                    if all(kind[y + (-1 if f == 0 else 1), xx] in (WALL,) for xx in range(x, x + size)):
                        put(t, x, y, size, 1, solid, n, 0, f=f)

    for r in rooms:
        n, t = r['n'], r['t']
        cx, cy = int(r['cx']), int(r['cy'])
        if t in ('hangar', 'dock'):
            # Малые корабли — картинки из assets/ships (те же, что на карте).
            # Рамка по размаху крыльев: ARC-170 ~23 м, Y-wing ~23 м в длину,
            # «Стервятник» ~8 м, «Гиена» ~10 м. Носом к выходу (к носу корабля).
            pool = CRAFT['republic' if rep else 'cis']
            if t == 'dock':
                cid, size = pool[0]
                put('craft', cx - size // 2, cy - size // 2, size, size, BLOCK, n, 1, ship=cid)
                continue
            big = max(sz for _, sz in pool)
            if r['w'] > r['h'] * 1.3:
                # поперечный ангар — ряды поперёк
                k = 0
                for y in range(r['y'] + 3, r['y'] + r['h'] - big - 2, big + 4):
                    for x in range(r['x'] + 3, r['x'] + r['w'] - big - 2, big + 3):
                        cid, size = pool[k % len(pool)]; k += 1
                        put('craft', x, y, size, size, BLOCK, n, 1, ship=cid)
            else:
                # продольный ангар: два ряда у бортов, посередине — полоса вылета
                lane = max(8, r['w'] // 4)
                k = 0
                for y in range(r['y'] + 4, r['y'] + r['h'] - big - 3, big + 3):
                    cid, size = pool[k % len(pool)]; k += 1
                    off = (big - size) // 2
                    put('craft', r['x'] + 3 + off, y + off, size, size, BLOCK, n, 1, ship=cid)
                    if r['w'] >= 2 * big + lane + 6:
                        put('craft', r['x'] + r['w'] - 3 - big + off, y + off, size, size, BLOCK, n, 1, ship=cid)
                    # третий ряд у широких ангаров
                    if r['w'] >= 3 * big + 2 * lane:
                        pass
        elif t in ('quarters', 'troops'):
            grid(n, r, 'bunk', 4, 2, 2, 2, COVER, 0)
        elif t == 'mess':
            grid(n, r, 'table', 5, 2, 3, 3, COVER, 0)
        elif t == 'medbay':
            grid(n, r, 'bed', 2, 4, 3, 3, COVER, 0)
            put('bacta', cx - 1, r['y'] + 2, 3, 3, BLOCK, n, 0)
        elif t in ('armory', 'storage', 'hold'):
            grid(n, r, 'crates', 3, 3, 3, 3, COVER if t != 'hold' else BLOCK, 0)
        elif t in ('bridge', 'flight', 'cic', 'comms', 'observe'):
            along_walls(n, r, 'console', 3, 4, COVER)
            if r['w'] >= 12 and r['h'] >= 10: put('holotable', cx - 2, cy - 2, 4, 4, BLOCK, n, 1)
            if t == 'observe': put('window', r['x'] + 2, r['y'] + 1, r['w'] - 4, 1, BLOCK, n, 0)
        elif t == 'gun':
            s = max(6, min(r['w'], r['h']) - 10)
            put('turret_base', cx - s // 2, cy - s // 2, s, s, BLOCK, n, 1)
            along_walls(n, r, 'console', 2, 5, COVER)
        elif t == 'reactor':
            s = max(6, min(r['w'], r['h']) - 8)
            put('reactor_core', cx - s // 2, cy - s // 2, s, s, BLOCK, n, 2)
            along_walls(n, r, 'console', 2, 6, COVER)
        elif t == 'shield':
            for dy in range(r['y'] + 4, r['y'] + r['h'] - 6, 10):
                put('shield_gen', cx - 3, dy, 6, 6, BLOCK, n, 1)
        elif t == 'engine':
            grid(n, r, 'engine_block', 6, 8, 4, 4, BLOCK, 1)
        elif t == 'hyper':
            s = max(5, min(r['w'], r['h']) - 8)
            put('hyper_core', cx - s // 2, cy - s // 2, s, s, BLOCK, n, 1)
        elif t == 'droids':
            grid(n, r, 'droid_rack', 2, 6, 3, 3, BLOCK, 0)
        elif t == 'vehicle':
            veh = 'atte' if rep else 'aat'
            grid(n, r, veh, 8, 6, 4, 3, BLOCK, 1, veh=veh)
        elif t == 'dock':
            put('shuttle', cx - 5, cy - 4, 10, 8, BLOCK, n, 1, ship='shuttle')
        elif t == 'workshop':
            grid(n, r, 'bench', 4, 2, 3, 3, COVER, 0)
        elif t == 'airlock':
            put('hatch', cx - 2, cy - 2, 4, 4, COVER, n, 1)
        elif t == 'pdgun':
            put('pd_base', cx - 2, cy - 2, 4, 4, BLOCK, n, 1)
            along_walls(n, r, 'console', 2, 5, COVER)

    # колонны в больших залах — чтобы зал держал перекрытие и не был пустой коробкой
    for r in rooms:
        if r['t'] in ('hangar', 'dock', 'reactor', 'gun', 'engine') or r['w'] < 34 or r['h'] < 30: continue
        for y in range(r['y'] + 9, r['y'] + r['h'] - 8, 14):
            for x in range(r['x'] + 9, r['x'] + r['w'] - 8, 16):
                put('pillar', x, y, 2, 2, BLOCK, r['n'], 1)

    # пометки предметов → обратно пол; проходимость предметов хранится в props
    kind[kind == 7] = FLOOR; kind[kind == 8] = FLOOR
    return props


# ---------------------------------------------------------------- проверка
def preview(data, kind, room, path):
    W, H = data['w'], data['h']; S = 3
    sp = Image.open(os.path.join(ROOT, data['sprite'])).convert('RGBA').crop(tuple(data['crop'])).resize((W * S, H * S), Image.LANCZOS)
    base = Image.new('RGBA', sp.size, (8, 10, 15, 255))
    dark = Image.eval(sp, lambda v: v)
    dark = Image.blend(Image.new('RGBA', sp.size, (0, 0, 0, 0)), sp, 0.45)
    base.alpha_composite(dark)
    px = np.array(base)
    COL = {'hangar': (70, 76, 88), 'bridge': (40, 70, 110), 'flight': (40, 70, 110), 'cic': (45, 60, 100), 'gun': (110, 60, 50),
           'reactor': (120, 90, 30), 'engine': (90, 70, 50), 'hyper': (80, 60, 110), 'shield': (40, 100, 120),
           'quarters': (70, 80, 70), 'troops': (70, 80, 70), 'mess': (80, 80, 60), 'medbay': (60, 100, 90), 'armory': (90, 70, 70),
           'storage': (75, 70, 60), 'hold': (75, 70, 60), 'droids': (85, 75, 55), 'vehicle': (70, 70, 80), 'dock': (60, 70, 80),
           'workshop': (80, 75, 60), 'airlock': (60, 60, 70), 'comms': (50, 80, 100), 'observe': (40, 70, 110), 'pdgun': (120, 70, 60)}
    rt = {r['n']: r['t'] for r in data['rooms']}
    for y in range(H):
        for x in range(W):
            k = kind[y, x]
            if k in (FLOOR, DOOR):
                c = COL.get(rt.get(room[y, x]), (95, 100, 108)) if room[y, x] else (105, 110, 118)
                if k == DOOR: c = (220, 180, 70)
                px[y * S:(y + 1) * S, x * S:(x + 1) * S, :3] = c
            elif k == WALL:
                px[y * S:(y + 1) * S, x * S:(x + 1) * S, :3] = (190, 196, 205)
    img = Image.fromarray(px)
    from PIL import ImageDraw
    d = ImageDraw.Draw(img)
    for p in data['props']:
        d.rectangle([p['x'] * S, p['y'] * S, (p['x'] + p['w']) * S - 1, (p['y'] + p['h']) * S - 1], outline=(20, 20, 20), fill=(30, 34, 40) if p['s'] == BLOCK else (150, 140, 110))
    for m in data['mounts']:
        d.ellipse([(m['x'] - 3) * S, (m['y'] - 3) * S, (m['x'] + 3) * S, (m['y'] + 3) * S], outline=(255, 80, 60), width=2)
    img.convert('RGB').save(path)


if __name__ == '__main__':
    png_dir = sys.argv[sys.argv.index('--png') + 1] if '--png' in sys.argv else None
    out_dir = os.path.join(ROOT, 'shared', 'ships'); os.makedirs(out_dir, exist_ok=True)
    index = []
    for sid, spec in SHIPS.items():
        data, kind, room = build(sid, spec)
        with open(os.path.join(out_dir, sid + '.json'), 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        walk = int(((kind == FLOOR) | (kind == DOOR)).sum())
        print('%-11s %3dx%-3d клеток  комнат %2d  дверей %2d  предметов %3d  пол %d' % (sid, data['w'], data['h'], len(data['rooms']), len(data['doors']), len(data['props']), walk))
        index.append({'id': sid, 'name': spec['name'], 'faction': spec['faction'], 'length_m': spec['length_m']})
        if png_dir: preview(data, kind, room, os.path.join(png_dir, 'ship_%s.png' % sid))
    with open(os.path.join(out_dir, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
