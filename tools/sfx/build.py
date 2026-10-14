#!/usr/bin/env python3
"""Звуки космического боя: собираются из записанных CC0-исходников (tools/sfx/src).

Исходники:
  - Kenney «Sci-Fi Sounds» 1.0 (CC0) — laser*, explosion*, lowFrequency*, impactMetal*, forceField*
  - Warfork (CC0, Team Forbidden) — electrobolt*, rocket*, gren*, plasmagun*, laser_hit*
Лицензии лежат рядом в src/.

Каждый звук — слои из нескольких записей: выстрел ствола (запись лазера, опущенная
по высоте — тяжёлый калибр ниже и длиннее), низкий удар отдачи и хвост
отражения. Итог — mono mp3 в assets/sfx/.

Запуск: python3 tools/sfx/build.py   (нужны numpy, scipy, ffmpeg)
"""
import os, subprocess, json
import numpy as np
from scipy.signal import butter, sosfilt

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'tools', 'sfx', 'src')
OUT = os.path.join(ROOT, 'assets', 'sfx')
SR = 44100
_cache = {}


def load(name):
    if name not in _cache:
        raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', os.path.join(SRC, name + '.ogg'),
                              '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'], capture_output=True, check=True).stdout
        _cache[name] = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    return _cache[name].copy()


def rate(x, r):
    """Проигрывание быстрее (r>1) или медленнее (r<1): высота и длина вместе, как на плёнке"""
    n = int(len(x) / r)
    return np.interp(np.arange(n) * r, np.arange(len(x)), x).astype(np.float32)


def lp(x, hz, order=4):
    return sosfilt(butter(order, hz, 'low', fs=SR, output='sos'), x).astype(np.float32)


def hp(x, hz, order=2):
    return sosfilt(butter(order, hz, 'high', fs=SR, output='sos'), x).astype(np.float32)


def cut(x, sec, fade=0.08):
    x = x[:int(sec * SR)].copy()
    f = min(len(x), int(fade * SR))
    if f: x[-f:] *= np.linspace(1, 0, f) ** 2
    return x


def norm(x, peak=1.0):
    m = np.abs(x).max() or 1
    return x * (peak / m)


def mix(*parts):
    """parts: (сигнал, громкость, задержка в с)"""
    n = max(int(d * SR) + len(s) for s, g, d in parts)
    out = np.zeros(n, np.float32)
    for s, g, d in parts:
        o = int(d * SR); out[o:o + len(s)] += s * g
    return out


def reverb(x, size=1.0, wet=0.25, damp=3500, seed=1):
    """Хвост отражения: свёртка с затухающим шумом (просторный ангар/корпус)"""
    rs = np.random.RandomState(seed)
    n = int(size * SR)
    t = np.arange(n) / SR
    ir = rs.randn(n).astype(np.float32) * np.exp(-t * 6.0 / size)
    ir = lp(ir, damp, 2); ir[:int(0.012 * SR)] = 0           # первые отражения через 12 мс
    ir /= np.sqrt((ir ** 2).sum())
    from scipy.signal import fftconvolve
    y = fftconvolve(x, ir)[:len(x) + n]
    dry = np.concatenate([x, np.zeros(len(y) - len(x), np.float32)])
    return dry * (1 - wet) + y * wet * 2.2


def fadein(x, sec=0.003):
    f = int(sec * SR); x = x.copy(); x[:f] *= np.linspace(0, 1, f); return x


def trim_tail(x, thr=0.002):
    a = np.abs(x); idx = np.where(a > thr)[0]
    return x[:idx[-1] + 1] if len(idx) else x


# ---------------------------------------------------------------- рецепты
def heavy(v):
    # тяжёлый турболазер: лазер на октаву ниже + удар отдачи + длинный хвост
    src = ['laserLarge_000', 'laserLarge_003', 'laserLarge_004'][v]
    bolt = lp(rate(load(src), 0.52), 6000)
    sub = lp(cut(load(['lowFrequency_explosion_001', 'lowFrequency_explosion_000', 'lowFrequency_explosion_001'][v]), 0.55), 400)
    body = lp(cut(rate(load('rocket_fire_strong'), 0.8), 0.5), 2500)
    x = mix((norm(bolt), 0.8, 0), (norm(sub), 0.9, 0.0), (norm(body), 0.25, 0.01))
    return cut(reverb(x, 1.3, 0.28, 3000, v + 1), 1.9, 0.5)


def medium(v):
    src = ['laserLarge_001', 'laserLarge_002', 'laserLarge_003'][v]
    bolt = lp(rate(load(src), [0.72, 0.62, 0.78][v]), 7500)
    sub = lp(cut(load('lowFrequency_explosion_001'), 0.3), 300)
    x = mix((norm(bolt), 0.85, 0), (norm(sub), 0.45, 0))
    return cut(reverb(x, 0.8, 0.22, 4000, v + 11), 1.2, 0.35)


def longgun(v):
    src = ['laserLarge_000', 'laserLarge_001'][v]
    bolt = lp(rate(load(src), 0.42), 5000)
    crack = hp(cut(load('rocket_fire_strong'), 0.35), 900)
    sub = lp(cut(load('lowFrequency_explosion_000'), 0.7), 250)
    x = mix((norm(crack), 0.35, 0), (norm(bolt), 0.8, 0.01), (norm(sub), 0.8, 0))
    return cut(reverb(x, 1.8, 0.3, 2500, v + 21), 2.4, 0.7)


def ion(v):
    zap = cut(load('electrobolt_strong'), [0.75, 0.6][v], 0.25)
    if v: zap = rate(zap, 0.85)
    hum = lp(rate(cut(load('forceField_002'), 0.6), 0.75), 1800)
    sub = lp(cut(load('lowFrequency_explosion_001'), 0.3), 250)
    x = mix((norm(zap), 0.75, 0), (norm(hum), 0.5, 0), (norm(sub), 0.5, 0))
    return cut(reverb(x, 0.9, 0.25, 4000, v + 31), 1.3, 0.4)


def pd(v):
    src = ['laserSmall_001', 'laserSmall_002', 'laserSmall_004'][v]
    x = hp(lp(rate(load(src), 0.9), 9000), 250)
    return cut(reverb(norm(x), 0.35, 0.15, 5000, v + 41), 0.55, 0.15)


def fighter(v):
    src = ['laserSmall_000', 'laserSmall_003'][v]
    x = hp(rate(load(src), 1.15), 400)
    return cut(norm(x), 0.35, 0.12)


def shield(v):
    ff = cut(load(['forceField_000', 'forceField_002', 'forceField_004'][v]), 0.55, 0.3)
    zap = load('laser_hit0')
    x = mix((norm(ff), 0.8, 0), (norm(hp(zap, 1500)), 0.35, 0))
    return cut(reverb(x, 0.6, 0.2, 5000, v + 51), 0.9, 0.3)


def hull(v):
    cr = rate(load(['explosionCrunch_000', 'explosionCrunch_002', 'explosionCrunch_004'][v]), 0.8)
    cr = lp(cut(cr, 1.0, 0.4), 5000)
    metal = load(['impactMetal_001', 'impactMetal_003', 'impactMetal_001'][v])
    sub = lp(cut(load('lowFrequency_explosion_001'), 0.5), 300)
    x = mix((norm(metal), 0.6, 0), (norm(cr), 0.75, 0.01), (norm(sub), 0.6, 0))
    return cut(reverb(x, 1.0, 0.22, 3000, v + 61), 1.6, 0.5)


def ionhit(v):
    x = mix((norm(load('electrobolt_hit')), 0.8, 0), (norm(lp(cut(load('forceField_004'), 0.5, 0.25), 2500)), 0.6, 0.01))
    return cut(reverb(x, 0.6, 0.2, 4000, 71), 0.9, 0.3)


def craftboom(v):
    a = load('plasmagun_strong_explosion')
    b = cut(rate(load(['explosionCrunch_000', 'explosionCrunch_002'][v]), 1.15), 0.7, 0.3)
    x = mix((norm(a), 0.6, 0), (norm(b), 0.7, 0.02))
    return cut(reverb(x, 0.7, 0.2, 4000, v + 81), 1.0, 0.35)


def shipboom(v):
    lo = lp(load(['lowFrequency_explosion_000', 'lowFrequency_explosion_000'][v]), 220)
    mid = lp(rate(load('rocket_strong_explosion'), [0.62, 0.55][v]), 3500)
    gr = lp(rate(load('gren_strong_explosion1'), 0.6), 3000)
    cr = lp(rate(load('explosionCrunch_004'), 0.7), 2500)
    x = mix((norm(lo), 1.0, 0), (norm(mid), 0.7, 0.03), (norm(gr), 0.5, 0.35 + v * 0.2), (norm(cr), 0.45, 0.8))
    return cut(reverb(x, 2.6, 0.32, 2000, v + 91), 4.5, 1.5)


RECIPES = {
    'heavy': (heavy, 3), 'medium': (medium, 3), 'long': (longgun, 2), 'ion': (ion, 2), 'pd': (pd, 3),
    'fighter': (fighter, 2), 'shield': (shield, 3), 'hull': (hull, 3), 'ionhit': (ionhit, 1),
    'craftboom': (craftboom, 2), 'shipboom': (shipboom, 2),
}


def save(name, x):
    x = fadein(trim_tail(x))
    x = norm(x, 0.89)                                    # -1 дБ: громкость по типу задаёт игра
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes()
    path = os.path.join(OUT, name + '.mp3')
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', str(SR), '-ac', '1', '-i', '-',
                    '-codec:a', 'libmp3lame', '-b:a', '80k', path], input=pcm, check=True)
    return len(x) / SR


def main():
    os.makedirs(OUT, exist_ok=True)
    index = {}
    for k, (fn, n) in RECIPES.items():
        index[k] = []
        for v in range(n):
            name = '%s_%d' % (k, v + 1)
            d = save(name, fn(v))
            index[k].append(name)
            print('%-12s %.2f с' % (name, d))
    with open(os.path.join(OUT, 'index.json'), 'w') as f:
        json.dump(index, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
