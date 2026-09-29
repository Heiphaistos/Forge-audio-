import { useEffect, useRef } from 'react';
import { engine } from '../audio/engine';
import { usePlayer } from '../store/player';

/** Frequency bars drawn from the engine's analyser. */
export function Visualizer({ bars = 48, className = '' }: { bars?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const playing = usePlayer((s) => s.playing);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !playing) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let last = 0;
    let data = new Uint8Array(0);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '255, 106, 26';
    const draw = () => {
      raf = requestAnimationFrame(draw);
      // 30 fps is plenty for bars and halves the work competing with audio decoding.
      const now = performance.now();
      if (now - last < 33 || document.hidden) return;
      last = now;
      const an = engine.analyser;
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      if (!an) return;
      if (data.length !== an.frequencyBinCount) data = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(data);
      const usable = Math.floor(data.length * 0.75);
      const w = width / bars;
      for (let i = 0; i < bars; i += 1) {
        const v = data[Math.floor((i / bars) * usable)] / 255;
        const h = Math.max(2, v * v * height);
        ctx.fillStyle = `rgba(${accent}, ${0.35 + v * 0.65})`;
        ctx.fillRect(i * w + 1, height - h, Math.max(1, w - 2), h);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [playing, bars]);

  return <canvas ref={ref} className={`visualizer ${className}`} width={bars * 8} height={64} aria-hidden />;
}
