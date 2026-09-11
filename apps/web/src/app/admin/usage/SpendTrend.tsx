'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * Spend over time — TWO charts, deliberately, not one chart with two y-axes.
 *
 * The ticket asks for two series, cost and tokens. They share no scale: cost is
 * fractions of a dollar and tokens are hundreds of thousands. Plotting both
 * against two different y-axes is the single commonest way to lie with a chart —
 * the crossing point, and therefore the whole story a reader takes away, is set
 * by where the author happened to put the two zero points. Small multiples over
 * one shared x-axis say the same thing and cannot be rigged.
 *
 * It also serves the question the ticket actually poses better. "Cost up while
 * tokens stay flat is a model swap; both climbing together is a prompt that got
 * longer" is read by comparing the SHAPE of two lines, and two aligned panels
 * make shape comparison easier than one panel with two scales, where the eye
 * keeps trying to read a crossing that means nothing.
 *
 * Colour: the Warm Ledger palette, not Recharts' defaults — green for the
 * settled money figure, bronze for throughput, matching what those two hues
 * already mean everywhere else in this app. As CSS variables, so the chart
 * follows the palette rather than pinning a copy of it.
 *
 * A note on that choice: the Warm Ledger green is desaturated enough to fail a
 * categorical-palette chroma floor — as a series hue among others it would read
 * as grey. That check does not apply here, because each panel carries exactly
 * one series and identity comes from the panel's own heading rather than from
 * hue. Both colours clear 3:1 against the card surface.
 *
 * AEH-313.
 */

export type TrendPoint = { day: string; cost: number; tokens: number };

/** Compact enough for an axis tick without becoming a puzzle. */
function abbreviate(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const AXIS = {
  stroke: 'var(--color-line)',
  tick: { fill: 'var(--color-ink-4)', fontSize: 10.5 },
  tickLine: false,
} as const;

export function SpendTrend({ points }: { points: TrendPoint[] }) {
  // One point draws no line, and an empty chart frame reads as "zero spend"
  // rather than "not enough days yet" — which are very different facts.
  if (points.length < 2) {
    return (
      <p className="mt-2.5 text-[12.5px] text-ink-3" data-testid="spend-trend-empty">
        Two days of recorded calls are needed before a trend can be drawn. There{' '}
        {points.length === 1 ? 'is one day' : 'are none'} in this view.
      </p>
    );
  }

  return (
    <div className="mt-2.5 grid gap-3 sm:grid-cols-2" data-testid="spend-trend">
      <Panel
        title="Cost"
        points={points}
        dataKey="cost"
        color="var(--color-green)"
        tickFormat={(v) => `$${v < 1 ? v.toFixed(3) : v.toFixed(0)}`}
        format={(v) => `$${v.toFixed(4)}`}
      />
      <Panel
        title="Tokens"
        points={points}
        dataKey="tokens"
        color="var(--color-bronze)"
        tickFormat={abbreviate}
        format={(v) => v.toLocaleString()}
      />
    </div>
  );
}

function Panel({
  title,
  points,
  dataKey,
  color,
  tickFormat,
  format,
}: {
  title: string;
  points: TrendPoint[];
  dataKey: 'cost' | 'tokens';
  color: string;
  tickFormat: (v: number) => string;
  format: (v: number) => string;
}) {
  return (
    <div className="rounded-[10px] border border-line bg-surface px-3 pt-3 pb-1">
      {/* The panel heading names the series, which is why neither panel carries
          a legend: one series needs no key to tell it from anything. */}
      <div className="eyebrow">{title} per day</div>
      <div className="mt-1.5 h-[132px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-line-soft)" vertical={false} />
            <XAxis
              dataKey="day"
              // 'YYYY-MM-DD' is too wide to repeat across a month of ticks, and
              // the year is constant across the window anyway.
              tickFormatter={(d: string) => d.slice(5)}
              minTickGap={24}
              {...AXIS}
            />
            <YAxis tickFormatter={tickFormat} width={48} {...AXIS} />
            <Tooltip
              cursor={{ stroke: 'var(--color-ink-4)', strokeDasharray: '3 3' }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const v = payload[0]?.value;
                return (
                  <div className="rounded-[6px] border border-line bg-surface px-2.5 py-1.5 text-[12px] shadow-sm">
                    <div className="num text-ink-3">{String(label)}</div>
                    <div className="num text-ink">
                      {typeof v === 'number' ? format(v) : '—'}
                    </div>
                  </div>
                );
              }}
            />
            <Line
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
