'use client';

import type { WidgetConfig } from '../BiTypes';
import { Fragment } from 'react';

interface Props {
  type: 'heading' | 'text';
  title: string;
  config: WidgetConfig;
}

// Markdown mínimo: **negrita**, saltos de línea y viñetas con "- ".
function renderInline(text: string): React.ReactNode {
  // Divide por **negrita** conservando los delimitadores.
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function RichText({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = (key: string) => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={key} className="list-disc pl-5 space-y-0.5">
        {bullets.map((b, i) => (
          <li key={i}>{renderInline(b)}</li>
        ))}
      </ul>
    );
    bullets = [];
  };

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      bullets.push(trimmed.slice(2));
    } else {
      flushBullets(`ul-${i}`);
      if (trimmed) blocks.push(<p key={`p-${i}`}>{renderInline(trimmed)}</p>);
    }
  });
  flushBullets('ul-end');

  return <div className="space-y-1.5">{blocks}</div>;
}

const HEADING_SIZE: Record<number, string> = {
  1: 'text-xl font-bold',
  2: 'text-lg font-semibold',
  3: 'text-base font-semibold',
};

export function TextWidget({ type, title, config }: Props) {
  const align = config.align === 'center' ? 'text-center' : 'text-left';

  if (type === 'heading') {
    const level = config.heading_level ?? 2;
    const accent = config.accent;
    return (
      <div className={`h-full flex flex-col justify-center py-2 ${align}`}>
        <div className="flex items-center gap-2.5">
          {accent && level === 1 && (
            <span className="h-6 w-1.5 rounded-full flex-shrink-0" style={{ background: accent }} />
          )}
          <h2
            className={`${HEADING_SIZE[level] ?? HEADING_SIZE[2]} tracking-tight text-foreground`}
            style={accent && level !== 1 ? { color: accent } : undefined}
          >
            {title}
          </h2>
        </div>
        {level <= 2 && <div className="mt-2 h-px w-full bg-border" />}
      </div>
    );
  }

  // type === 'text'
  return (
    <div className={`h-full rounded-2xl border border-border bg-card p-5 ${align}`}>
      {title && (
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          {title}
        </p>
      )}
      <div className="text-sm text-muted-foreground leading-relaxed">
        {config.text ? (
          <RichText text={config.text} />
        ) : (
          <span className="italic opacity-60">Sin texto</span>
        )}
      </div>
    </div>
  );
}
