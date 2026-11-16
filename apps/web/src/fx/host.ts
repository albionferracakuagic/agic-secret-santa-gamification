import type { FxHost } from './engine';
import { playSfx } from './audio';
import { FrameMonitor } from './perf';

export interface DomHostDeps {
  root: HTMLElement;
  snowCanvas: HTMLCanvasElement;
  confettiCanvas: HTMLCanvasElement;
  lightsEl: HTMLElement;
  announce: (text: string) => void;
  onSlow: () => void;
}

interface Flake {
  x: number;
  y: number;
  r: number;
  v: number;
}

/** Decorative DOM/canvas renderer. Everything lives under a pointer-events:none root (FR-038). */
export function createDomHost(d: DomHostDeps): FxHost & { dispose(): void } {
  let raf = 0;
  let flakes: Flake[] = [];
  let last = 0;
  const monitor = new FrameMonitor();
  let confettiFn: ((o: object) => unknown) | undefined;

  const loop = (t: number) => {
    const c = d.snowCanvas;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    c.width = d.root.clientWidth || 800;
    c.height = d.root.clientHeight || 600;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const f of flakes) {
      f.y += f.v;
      if (f.y > c.height) {
        f.y = -4;
        f.x = Math.random() * c.width;
      }
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (last && monitor.push(t - last, t)) d.onSlow();
    last = t;
    raf = requestAnimationFrame(loop);
  };

  const confetti = async (opts: object) => {
    if (!confettiFn) {
      const mod = await import('canvas-confetti');
      confettiFn = mod.default.create(d.confettiCanvas, { resize: true, useWorker: false });
    }
    confettiFn(opts);
  };

  return {
    emoji(glyph, count, durationMs) {
      for (let i = 0; i < count; i++) {
        const el = document.createElement('span');
        el.className = 'fx-float';
        el.textContent = glyph;
        el.setAttribute('aria-hidden', 'true');
        el.style.left = `${10 + Math.random() * 80}%`;
        el.style.setProperty('--fx-duration', `${durationMs}ms`);
        el.style.animationDelay = `${i * 120}ms`;
        el.addEventListener('animationend', () => el.remove());
        d.root.appendChild(el);
      }
    },
    confetti(count) {
      void confetti({
        particleCount: count,
        spread: 80,
        origin: { y: 0.7 },
        colors: ['#dc2626', '#16a34a', '#facc15', '#ffffff'],
      });
    },
    fireworks(bursts) {
      for (let i = 0; i < bursts; i++) {
        setTimeout(
          () =>
            void confetti({
              particleCount: 60,
              spread: 360,
              startVelocity: 25,
              origin: { x: Math.random(), y: Math.random() * 0.5 },
              colors: ['#facc15', '#fde68a', '#f59e0b'],
            }),
          i * 350,
        );
      }
    },
    snow(on, density) {
      cancelAnimationFrame(raf);
      last = 0;
      if (!on) {
        flakes = [];
        d.snowCanvas.getContext('2d')?.clearRect(0, 0, d.snowCanvas.width, d.snowCanvas.height);
        return;
      }
      const n = Math.round(60 * density);
      flakes = Array.from({ length: n }, () => ({
        x: Math.random() * (d.root.clientWidth || 800),
        y: Math.random() * (d.root.clientHeight || 600),
        r: 1 + Math.random() * 2.5,
        v: 0.5 + Math.random() * 1.2,
      }));
      raf = requestAnimationFrame(loop);
    },
    lights(on) {
      d.lightsEl.style.display = on ? 'block' : 'none';
    },
    announce: d.announce,
    play: (id) => void playSfx(id),
    dispose() {
      cancelAnimationFrame(raf);
    },
  };
}
