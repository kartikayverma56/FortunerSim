"""Cut seamless steady-rpm engine loops from recordings and write the sim's manifest.

Usage: python -I tools/audio/makeloops.py <spec.json>

spec.json:
{
  "out_dir": "public/audio/engine",
  "ref": "0772_off_ext",                       # loop whose bass balance the others are matched to
  "level_idle_db": -20, "level_rise_db": 10,   # target RMS at idle and the rise up to the top loop
  "tuning": { ... },                           # copied into the manifest
  "loops": [ { "name": "0772_off_ext", "src": "...wav", "t0": 37.7, "t1": 70.7, "rpm": 772,
               "load": "off", "position": "exterior", "len": 2.0, "credit": "..." }, ... ]
}
For each loop: track the firing frequency only within +-15 % of the expected rpm (so it can't lock to
half or double), pick the steadiest window, time-warp it to a constant rpm, cut a whole number of engine
cycles, crossfade the seam (40 ms, equal power, best-correlated end point), high-pass 20 Hz, match the
40-250 Hz / 250-2500 Hz balance to the reference loop (low shelf, max +-8 dB), and set the manifest gain
so loudness rises smoothly with rpm.
"""
import json
import os
import subprocess
import sys

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000


def load(path):
    sr, x = wavfile.read(path)
    x = x.astype(np.float64)
    if x.ndim > 1:
        x = x.mean(axis=1)
    x /= 32768.0
    if sr != SR:
        x = signal.resample_poly(x, SR, sr)
    return x


def f0_track(x, rpm, hop=0.05, win=0.4):
    """Firing frequency every `hop` s, searched only within +-15 % of rpm/30."""
    f_lo, f_hi = rpm / 30 * 0.85, rpm / 30 * 1.15
    grid = np.linspace(f_lo, f_hi, 241)
    dec = 20
    y = signal.sosfiltfilt(signal.butter(6, 1000, fs=SR, output='sos'), x)[::dec]
    fs = SR / dec
    n = int(win * fs); h = int(hop * fs); nfft = 16 * n
    freqs = np.fft.rfftfreq(nfft, 1 / fs); w = np.hanning(n)
    t, f, q = [], [], []
    for s in range(0, max(1, len(y) - n), h):
        sp = np.sqrt(np.abs(np.fft.rfft(y[s:s + n] * w, nfft)))
        sc = sum(np.interp(grid * k, freqs, sp) / k ** 0.3 for k in range(1, 9))
        i = int(np.argmax(sc))
        t.append((s + n / 2) / fs); f.append(grid[i]); q.append(sc[i] / (np.median(sc) + 1e-12))
    return np.array(t), np.array(f), np.array(q)


def steadiest(t, f, length):
    """Start time of the window of `length` s with the smallest relative f0 spread."""
    best, arg = 1e9, t[0]
    for i in range(len(t)):
        j = np.searchsorted(t, t[i] + length)
        if j >= len(t):
            break
        seg = f[i:j + 1]
        v = (seg.max() - seg.min()) / np.median(seg)
        if v < best:
            best, arg = v, t[i]
    return arg, best


def flatten(x, t, f, f_target):
    """Resample so the firing frequency is constant (removes warble when the loop wraps)."""
    ts = np.arange(len(x)) / SR
    fi = np.interp(ts, t, signal.savgol_filter(f, min(len(f) // 2 * 2 - 1, 9), 2) if len(f) >= 5 else f)
    phase = np.cumsum(fi / f_target) / SR  # "time" measured in target-rate seconds
    tq = np.arange(0, phase[-1], 1 / SR)
    return np.interp(tq, phase, x)


def make_loop(x, rpm, length, xf=0.040):
    cyc = 120.0 / rpm  # one 4-stroke cycle
    n_cyc = max(4, int(round(length / cyc)))
    L = int(round(n_cyc * cyc * SR)); X = int(xf * SR)
    if len(x) < L + X + int(cyc * SR):
        raise ValueError('segment too short')
    head = x[:X]
    # search the end point within +-half a cycle for the tail that best matches the head
    best, bestL = -1e9, L
    for d in range(-int(cyc * SR / 2), int(cyc * SR / 2), 4):
        e = L + d
        if e <= X or e + X > len(x):
            continue
        tail = x[e:e + X]
        c = np.dot(head, tail) / (np.linalg.norm(head) * np.linalg.norm(tail) + 1e-12)
        if c > best:
            best, bestL = c, e
    L = bestL
    y = x[:L].copy()
    a = np.linspace(0, np.pi / 2, X)
    y[:X] = x[:X] * np.sin(a) + x[L:L + X] * np.cos(a)  # tail after the end fades into the head
    return y, best, L / SR


def band_ratio_db(y):
    sp = np.abs(np.fft.rfft(y * np.hanning(len(y)))) ** 2
    fr = np.fft.rfftfreq(len(y), 1 / SR)
    lo = sp[(fr >= 40) & (fr < 250)].sum(); mid = sp[(fr >= 250) & (fr < 2500)].sum()
    return 10 * np.log10(lo / (mid + 1e-20) + 1e-20)


def low_shelf(y, gain_db, f0=200.0):
    """RBJ low-shelf biquad (S = 1)."""
    A = 10 ** (gain_db / 40); w0 = 2 * np.pi * f0 / SR; cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / 2 * np.sqrt(2)
    b0 = A * ((A + 1) - (A - 1) * cw + 2 * np.sqrt(A) * alpha); b1 = 2 * A * ((A - 1) - (A + 1) * cw)
    b2 = A * ((A + 1) - (A - 1) * cw - 2 * np.sqrt(A) * alpha); a0 = (A + 1) + (A - 1) * cw + 2 * np.sqrt(A) * alpha
    a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - 2 * np.sqrt(A) * alpha
    # run 3 passes over the looped signal so the filter state wraps (no click at the seam)
    yy = np.concatenate([y, y, y])
    out = signal.lfilter([b0 / a0, b1 / a0, b2 / a0], [1, a1 / a0, a2 / a0], yy)
    return out[len(y):2 * len(y)]


def main():
    spec = json.load(open(sys.argv[1], encoding='utf-8'))
    out_dir = spec['out_dir']; os.makedirs(out_dir, exist_ok=True)
    built = []
    for L in spec['loops']:
        x = load(L['src'])
        seg = x[int(L['t0'] * SR):int(L['t1'] * SR)]
        t, f, q = f0_track(seg, L['rpm'])
        length = L.get('len', 2.0)
        win = min(length + 0.6, (len(seg) / SR) - 0.3)
        t_start, spread = steadiest(t, f, win)
        a = int(max(0, t_start - 0.2) * SR); b = int(min(len(seg), (t_start + win + 0.2) * SR))
        piece = seg[a:b]
        tt, ff, _ = f0_track(piece, L['rpm'], hop=0.025, win=0.3)
        f_target = float(np.median(ff)); rpm_meas = f_target * 30
        flat = flatten(piece, tt, ff, f_target)
        flat = flat[int(0.15 * SR):]  # drop the warped edge
        sos = signal.butter(2, 20, btype='high', fs=SR, output='sos')
        flat = signal.sosfiltfilt(sos, flat - flat.mean())
        loop, corr, dur = make_loop(flat, rpm_meas, min(length, len(flat) / SR - 0.4))
        built.append({**L, 'rpm_meas': round(rpm_meas), 'spread_pct': round(spread * 100, 2), 'seam_corr': round(float(corr), 3), 'dur': round(dur, 3), 'y': loop})
    ref = next(b for b in built if b['name'] == spec['ref'])
    ref_ratio = band_ratio_db(ref['y'])
    rpms = [b['rpm_meas'] for b in built]; r0, r1 = min(rpms), max(rpms)
    manifest = []
    for b in built:
        shelf = float(np.clip(ref_ratio - band_ratio_db(b['y']), -8, 8)) if b is not ref else 0.0
        y = low_shelf(b['y'], shelf) if abs(shelf) > 0.5 else b['y']
        rms_db = 20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-12)
        target = spec.get('level_idle_db', -20) + spec.get('level_rise_db', 10) * np.log2(b['rpm_meas'] / r0) / max(1e-6, np.log2(r1 / r0))
        y = y * 10 ** ((target - rms_db) / 20)
        peak = np.abs(y).max()
        if peak > 0.98:
            y *= 0.98 / peak
        wav = os.path.join(out_dir, b['name'] + '.wav'); ogg = os.path.join(out_dir, b['name'] + '.ogg')
        wavfile.write(wav, SR, (y * 32767).astype(np.int16))
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav, '-c:a', 'libvorbis', '-q:a', '6', ogg], check=True)
        os.remove(wav)
        manifest.append({'file': b['name'] + '.ogg', 'rpm': b['rpm_meas'], 'load': b['load'], 'position': b['position']})
        print(f"{b['name']:16s} rpm {b['rpm']:5d}->{b['rpm_meas']:5d}  window spread {b['spread_pct']:5.2f}%  seam corr {b['seam_corr']:.3f}  "
              f"{b['dur']:.2f}s  low-shelf {shelf:+.1f} dB  level {target:.1f} dBFS  peak {20*np.log10(peak+1e-12):.1f}")
    out = {'loops': manifest, 'tuning': spec.get('tuning', {}), 'credits': [b['credit'] for b in built if b.get('credit')]}
    out['credits'] = sorted(set(out['credits']))
    with open(os.path.join(out_dir, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
    print('manifest:', os.path.join(out_dir, 'manifest.json'))


if __name__ == '__main__':
    main()
