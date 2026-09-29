import { SOURCE_COLORS, SOURCE_LABELS } from '../lib/format';

export function SourceBadge({ source }: { source: string }) {
  return (
    <span className="source-badge" style={{ ['--src' as string]: SOURCE_COLORS[source] || '#888' }} title={SOURCE_LABELS[source] || source}>
      {SOURCE_LABELS[source] || source}
    </span>
  );
}
