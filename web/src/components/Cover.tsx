import { Music2 } from 'lucide-react';
import { useState } from 'react';
import { coverUrl } from '../lib/format';
import { useOffline } from '../store/offline';

export function Cover({ src, size = 48, large = false, radius = 6, className = '' }: { src: string | null | undefined; size?: number | string; large?: boolean; radius?: number; className?: string }) {
  // 0: large variant, 1: original thumbnail, 2: placeholder
  const [stage, setStage] = useState(large ? 0 : 1);
  const [prevSrc, setPrevSrc] = useState(src);
  if (prevSrc !== src) {
    setPrevSrc(src);
    setStage(large ? 0 : 1);
  }
  // A downloaded title shows the cover saved with it (works offline, no data used).
  const local = useOffline((s) => (src ? s.covers[src] : undefined));
  const url = local || (stage === 0 ? coverUrl(src, true) : src);
  const style = { width: size, height: size, borderRadius: radius };
  if (!url || (stage === 2 && !local)) {
    return (
      <div className={`cover cover-empty ${className}`} style={style}>
        <Music2 size={typeof size === 'number' ? Math.max(16, size * 0.4) : 32} />
      </div>
    );
  }
  return <img className={`cover ${className}`} style={style} src={url} alt="" loading="lazy" onError={() => setStage(stage === 0 && coverUrl(src, true) !== src ? 1 : 2)} />;
}

/** 2×2 mosaic from the first covers of a playlist. */
export function Mosaic({ covers, size = 160, radius = 8 }: { covers: (string | null)[]; size?: number | string; radius?: number }) {
  const list = covers.filter(Boolean) as string[];
  const unique = [...new Set(list)].slice(0, 4);
  if (unique.length < 4) return <Cover src={unique[0]} size={size} radius={radius} />;
  return (
    <div className="mosaic" style={{ width: size, height: size, borderRadius: radius }}>
      {unique.map((c) => <img key={c} src={c} alt="" loading="lazy" />)}
    </div>
  );
}
