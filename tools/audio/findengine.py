"""Find stretches of a long recording that are mostly engine (one harmonic series, steady pitch).

Usage: python -I tools/audio/findengine.py <out_dir> <file.wav> [...] [--top 6] [--win 4]

Per window (default 4 s, hop 1 s):
  - best firing frequency f0 in 20-170 Hz by subharmonic summation (rpm = 30 f0)
  - engine score = share of 20-1500 Hz energy lying within +-3 % of the half-order series (k * f0 / 2)
  - pitch stability = spread of f0 over 0.5 s sub-windows
Music (several pitches, intervals of 1.12/1.19/1.33...), speech (fast pitch changes) and road noise
(no series) score low. Writes the top windows per file as WAV snippets plus candidates.json.
"""
import json
import os
import sys

import numpy as np
from scipy import signal
from scipy.io import wavfile

F0 = np.arange(20.0, 170.0, 0.25)


def best_f0(y, fs):
    n = len(y); nfft = 1 << int(np.ceil(np.log2(n * 4)))
    sp = np.sqrt(np.abs(np.fft.rfft(y * np.hanning(n), nfft))); fr = np.fft.rfftfreq(nfft, 1 / fs)
    sc = np.zeros_like(F0)
    for k in range(1, 9):
        sc += np.interp(F0 * k, fr, sp) / k ** 0.3 - 0.6 * np.interp(F0 * (k - 0.5), fr, sp) / k ** 0.3
    return F0[int(np.argmax(sc))]


def engine_share(y, fs, f0):
    n = len(y); nfft = 1 << int(np.ceil(np.log2(n * 2)))
    p = np.abs(np.fft.rfft(y * np.hanning(n), nfft)) ** 2; fr = np.fft.rfftfreq(nfft, 1 / fs)
    band = (fr >= 20) & (fr <= 1500)
    half = f0 / 2
    k = np.round(fr / half)
    near = band & (k >= 1) & (np.abs(fr - k * half) <= 0.03 * k * half + 0.6)
    return float(p[near].sum() / (p[band].sum() + 1e-20))


def analyse(path, win=4.0, hop=1.0):
    sr, x = wavfile.read(path); x = x.astype(np.float64)
    if x.ndim > 1:
        x = x.mean(axis=1)
    x /= 32768.0
    dec = sr // 4000; fs = sr / dec
    y = signal.decimate(signal.sosfiltfilt(signal.butter(6, 1600, fs=sr, output='sos'), x), dec, ftype='fir', zero_phase=True)
    rows = []
    n = int(win * fs)
    for s in range(0, len(y) - n, int(hop * fs)):
        seg = y[s:s + n]
        rms = 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-12)
        if rms < -45:
            continue
        subs = [best_f0(seg[i:i + int(0.5 * fs)], fs) for i in range(0, n - int(0.5 * fs) + 1, int(0.5 * fs))]
        f0 = float(np.median(subs))
        # fold sub-window octave slips onto the median before measuring spread
        folded = [f * 2 ** np.round(np.log2(f0 / f)) for f in subs]
        spread = float((np.max(folded) - np.min(folded)) / f0)
        share = engine_share(seg, fs, f0)
        score = share * (1 - min(1, spread / 0.12)) * (1 if rms > -38 else 0.5)
        rows.append({'t': round(s / fs, 1), 'rpm': int(round(f0 * 30)), 'share': round(share, 3), 'spread_pct': round(spread * 100, 1), 'dB': round(rms, 1), 'score': round(score, 3)})
    return sr, x, rows


def main():
    args = sys.argv[1:]
    top = 6; win = 4.0
    if '--top' in args:
        k = args.index('--top'); top = int(args[k + 1]); del args[k:k + 2]
    if '--win' in args:
        k = args.index('--win'); win = float(args[k + 1]); del args[k:k + 2]
    out_dir, files = args[0], args[1:]
    os.makedirs(out_dir, exist_ok=True)
    cands = []
    for path in files:
        sr, x, rows = analyse(path, win)
        name = os.path.splitext(os.path.basename(path))[0]
        picked = []
        for r in sorted(rows, key=lambda r: -r['score']):
            if r['score'] < 0.12 or len(picked) >= top:
                break
            if any(abs(r['t'] - p['t']) < win for p in picked):
                continue
            picked.append(r)
        print(f"{name}: {len(rows)} windows, picked {len(picked)}")
        for r in sorted(picked, key=lambda r: r['t']):
            fn = f"{name}_{int(r['t']*10):05d}.wav"
            a = int(r['t'] * sr); b = a + int(win * sr)
            seg = x[a:b]; seg = seg / (np.abs(seg).max() + 1e-9) * 0.7
            wavfile.write(os.path.join(out_dir, fn), sr, (seg * 32767).astype(np.int16))
            cands.append({**r, 'file': fn, 'src': name})
            print(f"   t {r['t']:6.1f}s  {r['rpm']:5d} rpm  engine share {r['share']:.2f}  pitch spread {r['spread_pct']:4.1f}%  {r['dB']} dB  score {r['score']}")
    with open(os.path.join(out_dir, 'candidates.json'), 'w') as fh:
        json.dump(cands, fh, indent=1)


if __name__ == '__main__':
    main()
