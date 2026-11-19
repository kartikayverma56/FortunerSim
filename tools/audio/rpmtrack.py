"""Track engine rpm over time in a recording of an inline-4 diesel (firing frequency f0 = rpm / 30 Hz).

Usage: python -I tools/audio/rpmtrack.py <file.wav> [...] [--json out.json] [--idle-max 950]

Method (per 0.1 s hop, 0.8 s window):
  - magnitude spectrum below 900 Hz, compressed (sqrt)
  - subharmonic summation: score(f0) = sum_k w_k S(k f0) - 0.6 * sum_k w_k S((k - 0.5) f0)
    (the second term punishes picking half the true f0)
  - a Viterbi path through the f0 grid with a penalty on log-frequency jumps, so the track is smooth
  - octave check: the quietest steady stretch is assumed to be idle; if it reads above --idle-max rpm
    the whole track is halved (some mics show 2 x firing frequency strongest)
Prints steady segments: rpm within +-1.5 % for >= 1.0 s.
"""
import json
import sys

import numpy as np
from scipy import signal
from scipy.io import wavfile

F0 = np.arange(20.0, 170.0, 0.25)  # 600 .. 5100 rpm


def load(path):
    sr, x = wavfile.read(path)
    x = x.astype(np.float64)
    if x.ndim > 1:
        x = x.mean(axis=1)
    return sr, x / 32768.0


def scores(sr, x, win=0.8, hop=0.1):
    dec = sr // 2400
    sos = signal.butter(6, 900, fs=sr, output='sos')
    y = signal.sosfiltfilt(sos, x)[::dec]
    fs = sr / dec
    n = int(win * fs); h = int(hop * fs); nfft = 8 * n
    freqs = np.fft.rfftfreq(nfft, 1 / fs)
    w = np.hanning(n)
    ks = np.arange(1, 11); wk = 1 / ks ** 0.3
    times, S, lvl = [], [], []
    for s in range(0, len(y) - n, h):
        seg = y[s:s + n]
        sp = np.sqrt(np.abs(np.fft.rfft(seg * w, nfft)))
        sc = np.zeros_like(F0)
        for k, wt in zip(ks, wk):
            sc += wt * np.interp(F0 * k, freqs, sp)
            sc -= 0.6 * wt * np.interp(F0 * (k - 0.5), freqs, sp)
        times.append((s + n / 2) / fs)
        S.append(sc / (np.abs(sc).max() + 1e-12))
        lvl.append(20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9))
    return np.array(times), np.array(S), np.array(lvl)


def viterbi(S, jump=6.0):
    """Max-score path; transition cost jump * |log2 ratio| per hop (an octave jump costs `jump`)."""
    logf = np.log2(F0)
    T, N = S.shape
    # banded transitions: allow up to +-12 % per hop
    band = int(np.ceil(np.log2(1.12) / (logf[-1] - logf[-2]))) + 1  # +-12 % per hop at the top of the grid
    acc = S[0].copy(); back = np.zeros((T, N), dtype=np.int32)
    for t in range(1, T):
        best = np.full(N, -np.inf); arg = np.zeros(N, dtype=np.int32)
        for d in range(-band, band + 1):  # target bin i comes from source bin i - d
            src = np.roll(acc, d)
            if d > 0:
                src[:d] = -np.inf
            elif d < 0:
                src[d:] = -np.inf
            cost = jump * np.abs(logf - np.roll(logf, d))  # an octave jump costs `jump`
            cand = src - cost
            better = cand > best
            best[better] = cand[better]; arg[better] = (np.arange(N) - d)[better]
        acc = best + S[t]; back[t] = arg
    path = np.zeros(T, dtype=np.int32); path[-1] = int(np.argmax(acc))
    for t in range(T - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return F0[path], S[np.arange(T), path]


def steady(times, rpm, conf, lvl, tol=0.015, min_len=1.0, min_conf=0.35):
    segs = []; i = 0; T = len(times)
    while i < T:
        if conf[i] < min_conf:
            i += 1; continue
        j = i
        while j + 1 < T and conf[j + 1] >= min_conf and abs(rpm[j + 1] / np.median(rpm[i:j + 2]) - 1) < tol:
            j += 1
        if times[j] - times[i] >= min_len:
            r = rpm[i:j + 1]
            segs.append({'t0': round(float(times[i]), 2), 't1': round(float(times[j]), 2), 'rpm': int(round(float(np.median(r)))),
                         'spread_pct': round(float((r.max() - r.min()) / np.median(r) * 100), 2), 'conf': round(float(conf[i:j + 1].mean()), 2),
                         'dB': round(float(lvl[i:j + 1].mean()), 1)})
            i = j + 1
        else:
            i += 1
    return segs


def analyse(path, idle_max=950):
    sr, x = load(path)
    times, S, lvl = scores(sr, x)
    f0, conf = viterbi(S)
    rpm = f0 * 30
    segs = steady(times, rpm, conf, lvl)
    note = ''
    loud = lvl > lvl.max() - 45  # ignore silence when looking for idle
    if segs:
        cand = [s for s in segs if s['dB'] > lvl.max() - 45]
        if cand:
            idle = min(cand, key=lambda s: s['dB'])
            if idle['rpm'] > idle_max and idle['rpm'] / 2 >= 600:
                rpm = rpm / 2; note = f"halved: quietest steady stretch read {idle['rpm']} rpm (> {idle_max}), so the strong line is 2 x firing"
                segs = steady(times, rpm, conf, lvl)
    return {'duration': round(len(x) / sr, 2), 'note': note, 'steady': segs,
            'track': [[round(float(t), 2), int(r), round(float(c), 2), round(float(l), 1)] for t, r, c, l in zip(times, rpm, conf, lvl)]}


def main():
    args = sys.argv[1:]
    out_json = None; idle_max = 950
    if '--json' in args:
        k = args.index('--json'); out_json = args[k + 1]; del args[k:k + 2]
    if '--idle-max' in args:
        k = args.index('--idle-max'); idle_max = float(args[k + 1]); del args[k:k + 2]
    result = {}
    for path in args:
        name = path.replace('\\', '/').split('/')[-1]
        r = analyse(path, idle_max); result[name] = r
        print(f"\n{name}: {r['duration']}s {r['note']}")
        for s in r['steady']:
            print(f"  steady {s['t0']:6.1f}-{s['t1']:6.1f}s  {s['rpm']:5d} rpm  spread {s['spread_pct']}%  conf {s['conf']}  {s['dB']} dBFS")
    if out_json:
        with open(out_json, 'w') as f:
            json.dump(result, f)


if __name__ == '__main__':
    main()
