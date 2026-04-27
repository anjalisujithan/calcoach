import { useRef, useEffect, useState } from 'react';
import { parseISO, format } from 'date-fns';
import { ReflectionEntry } from './ReflectionPanel';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sessionDuration(r: ReflectionEntry): number {
  const [sh, sm] = r.startTime.split(':').map(Number);
  const [eh, em] = r.endTime.split(':').map(Number);
  return Math.max(0, eh * 60 + em - (sh * 60 + sm));
}

function fmtHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

function fmtMins(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const PRODUCTIVITY_COLOR = (avg: number): string => {
  if (avg < 1.5) return '#ea4335';
  if (avg < 2.5) return '#ff7043';
  if (avg < 3.5) return '#fbbc04';
  if (avg < 4.5) return '#8bc34a';
  return '#34a853';
};

const FACE = ['', '😞', '😕', '😐', '🙂', '😄'];

// ── Aggregation ───────────────────────────────────────────────────────────────

interface ProdPoint { key: string; label: string; avgProductivity: number; sessionCount: number; }
interface SubjectPoint { title: string; totalMins: number; sessionCount: number; avgProductivity: number; hasReflection: boolean; }
interface CalSession { title: string; durationMins: number; date?: string; }
interface InsightsChatTurn { role: 'user' | 'assistant'; text: string; }

function byHour(reflections: ReflectionEntry[]): ProdPoint[] {
  const g: Record<number, number[]> = {};
  for (const r of reflections) {
    const h = Number(r.startTime.split(':')[0]);
    (g[h] ??= []).push(r.productivity);
  }
  return Object.entries(g)
    .sort(([a], [b]) => +a - +b)
    .map(([h, vals]) => ({
      key: h,
      label: fmtHour(+h),
      avgProductivity: vals.reduce((a, b) => a + b, 0) / vals.length,
      sessionCount: vals.length,
    }));
}

function byDow(reflections: ReflectionEntry[]): ProdPoint[] {
  const g: Record<number, number[]> = {};
  for (const r of reflections) {
    const d = parseISO(r.date).getDay();
    (g[d] ??= []).push(r.productivity);
  }
  return Object.entries(g)
    .sort(([a], [b]) => +a - +b)
    .map(([d, vals]) => ({
      key: d,
      label: DOW[+d],
      avgProductivity: vals.reduce((a, b) => a + b, 0) / vals.length,
      sessionCount: vals.length,
    }));
}

function byLocation(reflections: ReflectionEntry[]): ProdPoint[] {
  const g: Record<string, number[]> = {};
  for (const r of reflections) {
    if (!r.location) continue;
    (g[r.location] ??= []).push(r.productivity);
  }
  return Object.entries(g)
    .map(([loc, vals]) => ({
      key: loc,
      label: loc,
      avgProductivity: vals.reduce((a, b) => a + b, 0) / vals.length,
      sessionCount: vals.length,
    }))
    .sort((a, b) => b.avgProductivity - a.avgProductivity);
}

function bySubject(sessions: CalSession[], reflections: ReflectionEntry[]): SubjectPoint[] {
  // Total time from all calendar events
  const sesMap: Record<string, { totalMins: number; count: number }> = {};
  for (const s of sessions) {
    if (!sesMap[s.title]) sesMap[s.title] = { totalMins: 0, count: 0 };
    sesMap[s.title].totalMins += s.durationMins;
    sesMap[s.title].count += 1;
  }
  // Productivity from reflections only
  const refProds: Record<string, number[]> = {};
  for (const r of reflections) {
    (refProds[r.title] ??= []).push(r.productivity);
    // Include reflected subjects not currently on the calendar
    if (!sesMap[r.title]) sesMap[r.title] = { totalMins: 0, count: 0 };
    if (sesMap[r.title].totalMins === 0) {
      sesMap[r.title].totalMins += sessionDuration(r);
      sesMap[r.title].count += 1;
    }
  }
  return Object.entries(sesMap)
    .filter(([, { totalMins }]) => totalMins > 0)
    .map(([title, { totalMins, count }]) => {
      const prods = refProds[title] ?? [];
      return {
        title,
        totalMins,
        sessionCount: count,
        avgProductivity: prods.length > 0 ? prods.reduce((a, b) => a + b, 0) / prods.length : 0,
        hasReflection: prods.length > 0,
      };
    })
    .sort((a, b) => b.totalMins - a.totalMins)
    .slice(0, 12);
}

// ── MCQ Aggregation ───────────────────────────────────────────────────────────

interface McqOption { value: string; label: string; color: string; }
interface McqDist extends McqOption { count: number; pct: number; }
interface McqRow { question: string; items: McqDist[]; total: number; }
interface UnderestPoint { title: string; rate: number; tooShort: number; total: number; }
interface TimingProdPoint { label: string; value: string; avgProd: number; count: number; }

const LENGTH_OPTS: McqOption[] = [
  { value: 'too_short',  label: 'Too short',   color: '#ff7043' },
  { value: 'just_right', label: 'Just right',  color: '#34a853' },
  { value: 'too_long',   label: 'Too long',    color: '#4285f4' },
];
const TIMING_OPTS: McqOption[] = [
  { value: 'too_early',   label: 'Too early',    color: '#ff7043' },
  { value: 'good_timing', label: 'Good timing',  color: '#34a853' },
  { value: 'too_late',    label: 'Too late',     color: '#4285f4' },
];
const BREAKS_OPTS: McqOption[] = [
  { value: 'too_many',   label: 'Too many',    color: '#4285f4' },
  { value: 'just_right', label: 'Just right',  color: '#34a853' },
  { value: 'too_few',    label: 'Too few',     color: '#ff7043' },
];

function mcqRows(reflections: ReflectionEntry[]): McqRow[] {
  function dist(field: keyof ReflectionEntry, opts: McqOption[]): McqDist[] {
    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of reflections) {
      const v = r[field] as string | undefined;
      if (v) { counts[v] = (counts[v] ?? 0) + 1; total++; }
    }
    return opts.map(o => ({ ...o, count: counts[o.value] ?? 0, pct: total > 0 ? Math.round((counts[o.value] ?? 0) / total * 100) : 0 }));
  }
  const lenItems  = dist('sessionLengthFeedback', LENGTH_OPTS);
  const timeItems = dist('timingFeedback', TIMING_OPTS);
  const brkItems  = dist('breaksFeedback', BREAKS_OPTS);
  const lenTotal  = lenItems.reduce((s, d) => s + d.count, 0);
  const timeTotal = timeItems.reduce((s, d) => s + d.count, 0);
  const brkTotal  = brkItems.reduce((s, d) => s + d.count, 0);
  return [
    { question: 'Session length',  items: lenItems,  total: lenTotal  },
    { question: 'Timing',          items: timeItems, total: timeTotal },
    { question: 'Breaks',          items: brkItems,  total: brkTotal  },
  ].filter(r => r.total > 0);
}

function underestimatedSubjects(reflections: ReflectionEntry[]): UnderestPoint[] {
  const g: Record<string, { tooShort: number; total: number }> = {};
  for (const r of reflections) {
    if (!r.sessionLengthFeedback) continue;
    if (!g[r.title]) g[r.title] = { tooShort: 0, total: 0 };
    g[r.title].total++;
    if (r.sessionLengthFeedback === 'too_short') g[r.title].tooShort++;
  }
  return Object.entries(g)
    .filter(([, v]) => v.total >= 2)
    .map(([title, v]) => ({ title, rate: v.tooShort / v.total, tooShort: v.tooShort, total: v.total }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 8);
}

function productivityByTiming(reflections: ReflectionEntry[]): TimingProdPoint[] {
  const g: Record<string, number[]> = {};
  for (const r of reflections) {
    if (!r.timingFeedback) continue;
    (g[r.timingFeedback] ??= []).push(r.productivity);
  }
  return (['too_early', 'good_timing', 'too_late'] as const)
    .filter(v => g[v]?.length)
    .map(v => ({
      label: v === 'too_early' ? 'Too early' : v === 'good_timing' ? 'Good timing' : 'Too late',
      value: v,
      avgProd: g[v].reduce((a, b) => a + b, 0) / g[v].length,
      count: g[v].length,
    }));
}

function justRightRate(reflections: ReflectionEntry[], field: keyof ReflectionEntry, justRightValue: string): number | null {
  const withData = reflections.filter(r => r[field]);
  if (withData.length === 0) return null;
  return withData.filter(r => r[field] === justRightValue).length / withData.length;
}

function buildInsightsMetrics(reflections: ReflectionEntry[], sessions: CalSession[]) {
  const hourData = byHour(reflections);
  const dowData = byDow(reflections);
  const subjData = bySubject(sessions, reflections);
  const locData = byLocation(reflections);
  const avgProd = reflections.length > 0
    ? reflections.reduce((sum, r) => sum + r.productivity, 0) / reflections.length
    : 0;
  const bestHour = hourData.length > 0 ? hourData.reduce((best, x) => x.avgProductivity > best.avgProductivity ? x : best) : null;
  const bestDow = dowData.length > 0 ? dowData.reduce((best, x) => x.avgProductivity > best.avgProductivity ? x : best) : null;
  const totalCalendarMinutes = sessions.reduce((sum, s) => sum + (s.durationMins || 0), 0);
  const totalReflectionMinutes = reflections.reduce((sum, r) => sum + sessionDuration(r), 0);

  return {
    totalCalendarMinutes,
    totalReflectionMinutes,
    reflectionCount: reflections.length,
    sessionCount: sessions.length,
    avgProductivity: Number(avgProd.toFixed(2)),
    bestHour: bestHour ? { label: bestHour.label, avgProductivity: Number(bestHour.avgProductivity.toFixed(2)), count: bestHour.sessionCount } : null,
    bestWeekday: bestDow ? { label: bestDow.label, avgProductivity: Number(bestDow.avgProductivity.toFixed(2)), count: bestDow.sessionCount } : null,
    topSubjects: subjData.slice(0, 8).map(s => ({
      title: s.title,
      totalMins: s.totalMins,
      avgProductivity: Number(s.avgProductivity.toFixed(2)),
      hasReflection: s.hasReflection,
    })),
    topLocations: locData.slice(0, 6).map(l => ({
      location: l.label,
      avgProductivity: Number(l.avgProductivity.toFixed(2)),
      count: l.sessionCount,
    })),
  };
}

// ── MCQ charts ────────────────────────────────────────────────────────────────

function McqStackedBars({ rows }: { rows: McqRow[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {rows.map(row => (
        <div key={row.question}>
          <div style={{ fontSize: 12, color: '#70757a', marginBottom: 4, fontWeight: 500 }}>
            {row.question} <span style={{ fontWeight: 400, color: '#bdc1c6' }}>({row.total} response{row.total !== 1 ? 's' : ''})</span>
          </div>
          {/* Stacked bar */}
          <div style={{ display: 'flex', height: 22, borderRadius: 6, overflow: 'hidden', gap: 1 }}>
            {row.items.filter(d => d.count > 0).map(d => (
              <div
                key={d.value}
                style={{ width: `${d.pct}%`, background: d.color, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: d.pct > 8 ? 0 : undefined, transition: 'width 0.3s' }}
                title={`${d.label}: ${d.count} (${d.pct}%)`}
              >
                {d.pct >= 12 && <span style={{ fontSize: 10, color: '#fff', fontWeight: 600 }}>{d.pct}%</span>}
              </div>
            ))}
          </div>
          {/* Legend */}
          <div style={{ display: 'flex', gap: 12, marginTop: 5, flexWrap: 'wrap' }}>
            {row.items.map(d => (
              <span key={d.value} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#5f6368' }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: d.color, display: 'inline-block' }} />
                {d.label} ({d.pct}%)
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function UnderestimatedChart({ data }: { data: UnderestPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  const [hov, setHov] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  const ROW_H = 36, LABEL_W = 150, VALUE_W = 60;
  const mg = { top: 8, right: VALUE_W, bottom: 16, left: LABEL_W };
  const cW = Math.max(0, width - mg.left - mg.right);
  const svgH = data.length * ROW_H + mg.top + mg.bottom;

  return (
    <div ref={ref} style={{ width: '100%' }}>
      {data.length === 0 ? (
        <div style={{ fontSize: 13, color: '#9aa0a6', padding: '12px 0' }}>
          Need ≥ 2 reflections per subject to show underestimation patterns.
        </div>
      ) : (
        <svg width={width} height={svgH} style={{ display: 'block', overflow: 'visible' }}>
          <g transform={`translate(${mg.left},${mg.top})`}>
            <line x1={0} x2={0} y1={0} y2={data.length * ROW_H} stroke="#e0e0e0" />
            {data.map((d, i) => {
              const barW = d.rate * cW;
              const y = i * ROW_H;
              const midY = y + ROW_H / 2;
              const barColor = d.rate > 0.6 ? '#ea4335' : d.rate > 0.35 ? '#ff7043' : '#fbbc04';
              return (
                <g key={d.title} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}>
                  {hov === i && <rect x={-LABEL_W} y={y+2} width={width} height={ROW_H-4} rx={4} fill="#f8f9fa" />}
                  <text x={-10} y={midY+4} textAnchor="end" fontSize={12} fill="#3c4043" style={{ fontWeight: hov === i ? 600 : 400 }}>
                    {d.title.length > 20 ? d.title.slice(0, 18) + '…' : d.title}
                  </text>
                  <rect x={0} y={y+8} width={Math.max(barW, 3)} height={ROW_H-16} rx={4}
                    fill={barColor} opacity={hov === null || hov === i ? 0.85 : 0.35}
                    style={{ transition: 'opacity 0.12s' }} />
                  <text x={Math.max(barW, 3) + 6} y={midY+4} fontSize={11} fill="#5f6368">
                    {Math.round(d.rate * 100)}% ({d.tooShort}/{d.total})
                  </text>
                  <line x1={-LABEL_W} x2={cW + VALUE_W} y1={y+ROW_H-1} y2={y+ROW_H-1} stroke="#f1f3f4" />
                </g>
              );
            })}
            <text x={0} y={data.length * ROW_H + 13} textAnchor="middle" fontSize={10} fill="#9aa0a6">0%</text>
            <text x={cW/2} y={data.length * ROW_H + 13} textAnchor="middle" fontSize={10} fill="#9aa0a6">50%</text>
            <text x={cW} y={data.length * ROW_H + 13} textAnchor="middle" fontSize={10} fill="#9aa0a6">100%</text>
          </g>
        </svg>
      )}
    </div>
  );
}

function TimingProdChart({ data }: { data: TimingProdPoint[] }) {
  const COLOR: Record<string, string> = { too_early: '#ff7043', good_timing: '#34a853', too_late: '#4285f4' };
  const H = 180, mg = { top: 16, right: 16, bottom: 36, left: 46 };
  const [hov, setHov] = useState<number | null>(null);
  const cH = H - mg.top - mg.bottom;
  const slotW = data.length > 0 ? 260 / data.length : 80;
  const barW = Math.min(52, slotW * 0.65);
  const yPos = (v: number) => cH - (v / 5) * cH;
  const totalW = mg.left + data.length * slotW + mg.right;

  return (
    <svg width={totalW} height={H} style={{ display: 'block', overflow: 'visible' }}>
      <g transform={`translate(${mg.left},${mg.top})`}>
        {[1,2,3,4,5].map(v => (
          <g key={v}>
            <line x1={0} x2={data.length * slotW} y1={yPos(v)} y2={yPos(v)} stroke="#f1f3f4" />
            <text x={-8} y={yPos(v)+4} textAnchor="end" fontSize={10} fill="#9aa0a6">{v}</text>
          </g>
        ))}
        <line x1={0} x2={0} y1={0} y2={cH} stroke="#e0e0e0" />
        <line x1={0} x2={data.length * slotW} y1={cH} y2={cH} stroke="#e0e0e0" />
        {data.map((d, i) => {
          const bH = (d.avgProd / 5) * cH;
          const x = i * slotW + (slotW - barW) / 2;
          const y = cH - bH;
          return (
            <g key={d.value} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}>
              <rect x={x} y={y} width={barW} height={bH} rx={4}
                fill={COLOR[d.value]} opacity={hov === null || hov === i ? 1 : 0.4}
                style={{ transition: 'opacity 0.12s' }} />
              <text x={x + barW/2} y={cH+14} textAnchor="middle" fontSize={11} fill="#70757a">{d.label}</text>
              {hov === i && (
                <g>
                  <rect x={x+barW/2-40} y={Math.max(y-38, 0)} width={80} height={34} rx={5} fill="rgba(32,33,36,.9)" />
                  <text x={x+barW/2} y={Math.max(y-38,0)+14} textAnchor="middle" fontSize={12} fontWeight="600" fill="#fff">
                    {FACE[Math.round(d.avgProd)]} {d.avgProd.toFixed(2)}
                  </text>
                  <text x={x+barW/2} y={Math.max(y-38,0)+28} textAnchor="middle" fontSize={10} fill="#bdc1c6">
                    {d.count} session{d.count !== 1 ? 's' : ''}
                  </text>
                </g>
              )}
            </g>
          );
        })}
        <text transform="rotate(-90)" x={-cH/2} y={-36} textAnchor="middle" fontSize={10} fill="#9aa0a6">Avg productivity</text>
      </g>
    </svg>
  );
}

// ── Vertical bar chart (reused for hour + day-of-week) ────────────────────────

function ProdBarChart({ data, yLabel }: { data: ProdPoint[]; yLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hov, setHov] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  const H = 180, mg = { top: 14, right: 16, bottom: 38, left: 40 };
  const cW = Math.max(0, width - mg.left - mg.right);
  const cH = H - mg.top - mg.bottom;
  const slotW = data.length > 0 ? cW / data.length : cW;
  const barW = Math.max(6, Math.min(52, slotW * 0.6));
  const yPos = (v: number) => cH - (v / 5) * cH;

  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={width} height={H} style={{ display: 'block', overflow: 'visible' }}>
        <g transform={`translate(${mg.left},${mg.top})`}>
          {[1,2,3,4,5].map(v => (
            <g key={v}>
              <line x1={0} x2={cW} y1={yPos(v)} y2={yPos(v)} stroke="#f1f3f4" />
              <text x={-8} y={yPos(v)+4} textAnchor="end" fontSize={10} fill="#9aa0a6">{v}</text>
            </g>
          ))}
          <line x1={0} x2={0} y1={0} y2={cH} stroke="#e0e0e0" />
          <line x1={0} x2={cW} y1={cH} y2={cH} stroke="#e0e0e0" />

          {data.map((d, i) => {
            const bH = (d.avgProductivity / 5) * cH;
            const x = i * slotW + (slotW - barW) / 2;
            const y = cH - bH;
            const lx = x + barW / 2, ly = cH + 14;
            return (
              <g key={d.key} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}>
                <rect x={x} y={y} width={barW} height={bH} rx={4}
                  fill={PRODUCTIVITY_COLOR(d.avgProductivity)}
                  opacity={hov === null || hov === i ? 1 : 0.4}
                  style={{ transition: 'opacity 0.12s' }} />
                <text x={lx} y={ly} textAnchor="middle" fontSize={11} fill="#70757a">{d.label}</text>
                {hov === i && (() => {
                  const ttW = 86, ttH = 44;
                  const tx = Math.min(Math.max(x + barW/2 - ttW/2, 0), cW - ttW);
                  const ty = Math.max(y - ttH - 6, 0);
                  return (
                    <g>
                      <rect x={tx} y={ty} width={ttW} height={ttH} rx={5} fill="rgba(32,33,36,.9)" />
                      <text x={tx+ttW/2} y={ty+15} textAnchor="middle" fontSize={12} fontWeight="600" fill="#fff">
                        {FACE[Math.round(d.avgProductivity)]} {d.avgProductivity.toFixed(2)}
                      </text>
                      <text x={tx+ttW/2} y={ty+30} textAnchor="middle" fontSize={10} fill="#bdc1c6">
                        {d.sessionCount} session{d.sessionCount !== 1 ? 's' : ''}
                      </text>
                    </g>
                  );
                })()}
              </g>
            );
          })}

          <text transform="rotate(-90)" x={-cH/2} y={-36} textAnchor="middle" fontSize={10} fill="#9aa0a6">
            {yLabel}
          </text>
        </g>
      </svg>
    </div>
  );
}

// ── Horizontal bar chart (time by subject) ────────────────────────────────────

function SubjectChart({ data }: { data: SubjectPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hov, setHov] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  const ROW_H = 36, LABEL_W = 160, VALUE_W = 64;
  const mg = { top: 12, right: VALUE_W, bottom: 20, left: LABEL_W };
  const cW = Math.max(0, width - mg.left - mg.right);
  const svgH = data.length * ROW_H + mg.top + mg.bottom;
  const maxMins = Math.max(...data.map(d => d.totalMins), 1);

  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={width} height={svgH} style={{ display: 'block', overflow: 'visible' }}>
        <g transform={`translate(${mg.left},${mg.top})`}>
          <line x1={0} x2={0} y1={0} y2={data.length * ROW_H} stroke="#e0e0e0" />

          {data.map((d, i) => {
            const barW = (d.totalMins / maxMins) * cW;
            const y = i * ROW_H;
            const midY = y + ROW_H / 2;
            return (
              <g key={d.title} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}>
                {/* Row background on hover */}
                {hov === i && (
                  <rect x={-LABEL_W} y={y+2} width={width} height={ROW_H-4} rx={4} fill="#f8f9fa" />
                )}
                {/* Label */}
                <text x={-10} y={midY+4} textAnchor="end" fontSize={12} fill="#3c4043"
                  style={{ fontWeight: hov === i ? 600 : 400 }}>
                  {d.title.length > 22 ? d.title.slice(0, 20) + '…' : d.title}
                </text>
                {/* Bar */}
                <rect x={0} y={y + 8} width={Math.max(barW, 3)} height={ROW_H - 16} rx={4}
                  fill={d.hasReflection ? PRODUCTIVITY_COLOR(d.avgProductivity) : '#bdc1c6'}
                  opacity={hov === null || hov === i ? 0.85 : 0.35}
                  style={{ transition: 'opacity 0.12s' }} />
                {/* Value */}
                <text x={Math.max(barW, 3) + 8} y={midY + 4} fontSize={11} fill="#5f6368">
                  {fmtMins(d.totalMins)}
                </text>
                {/* Session count */}
                <text x={cW + VALUE_W - 4} y={midY + 4} textAnchor="end" fontSize={10} fill="#9aa0a6">
                  {d.sessionCount}×
                </text>
                {/* Divider */}
                <line x1={-LABEL_W} x2={cW + VALUE_W} y1={y + ROW_H - 1} y2={y + ROW_H - 1}
                  stroke="#f1f3f4" />
              </g>
            );
          })}

          {/* X axis labels: 0, midpoint, max */}
          <text x={0} y={data.length * ROW_H + 16} textAnchor="middle" fontSize={10} fill="#9aa0a6">0</text>
          <text x={cW/2} y={data.length * ROW_H + 16} textAnchor="middle" fontSize={10} fill="#9aa0a6">
            {fmtMins(Math.round(maxMins / 2))}
          </text>
          <text x={cW} y={data.length * ROW_H + 16} textAnchor="middle" fontSize={10} fill="#9aa0a6">
            {fmtMins(maxMins)}
          </text>
        </g>
      </svg>
    </div>
  );
}

// ── Smart Feedback Panel ──────────────────────────────────────────────────────

function SmartFeedbackPanel({ reflections, sessions, userEmail }: { reflections: ReflectionEntry[]; sessions: CalSession[]; userEmail?: string }) {
  const [fullText, setFullText] = useState<string | null>(null);
  const [displayed, setDisplayed] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<InsightsChatTurn[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [fullReflections, setFullReflections] = useState<ReflectionEntry[]>(reflections);
  const [fullSessions, setFullSessions] = useState<CalSession[]>(sessions);
  const hasTriedRef = useRef(false);
  const chatTypeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function clearChatTypeTimer() {
    if (chatTypeTimerRef.current) {
      clearInterval(chatTypeTimerRef.current);
      chatTypeTimerRef.current = null;
    }
  }

  function typeAssistantReply(baseHistory: InsightsChatTurn[], replyText: string) {
    clearChatTypeTimer();
    const safeReply = (replyText || '').trim() || 'No response.';
    setChatHistory([...baseHistory, { role: 'assistant', text: '' }]);
    let i = 0;
    chatTypeTimerRef.current = setInterval(() => {
      i += 1;
      const next = safeReply.slice(0, i);
      setChatHistory([...baseHistory, { role: 'assistant', text: next }]);
      if (i >= safeReply.length) {
        clearChatTypeTimer();
      }
    }, 12);
  }

  useEffect(() => { setFullReflections(reflections); }, [reflections]);
  useEffect(() => { setFullSessions(sessions); }, [sessions]);
  useEffect(() => () => clearChatTypeTimer(), []);

  useEffect(() => {
    if (!userEmail) return;
    let cancelled = false;
    (async () => {
      try {
        const [refRes, sesRes] = await Promise.all([
          fetch(`${API}/reflections?user_id=${encodeURIComponent(userEmail)}`),
          fetch(`${API}/sessions?user_id=${encodeURIComponent(userEmail)}`),
        ]);
        const refData = await refRes.json().catch(() => []);
        const sesData = await sesRes.json().catch(() => ({}));
        if (cancelled) return;
        if (Array.isArray(refData) && refData.length > 0) setFullReflections(refData);
        if (Array.isArray(sesData?.sessions) && sesData.sessions.length > 0) setFullSessions(sesData.sessions);
      } catch {
        // fallback to in-memory props
      }
    })();
    return () => { cancelled = true; };
  }, [userEmail]);

  // Typewriter effect whenever fullText changes
  useEffect(() => {
    if (!fullText) { setDisplayed(''); return; }
    setDisplayed('');
    setIsTyping(true);
    let i = 0;
    const iv = setInterval(() => {
      i++;
      setDisplayed(fullText.slice(0, i));
      if (i >= fullText.length) { clearInterval(iv); setIsTyping(false); }
    }, 14);
    return () => clearInterval(iv);
  }, [fullText]);

  async function generate() {
    if (!fullReflections.length && !fullSessions.length) return;
    setLoading(true);
    setError(null);
    setFullText(null);
    try {
      const res = await fetch(`${API}/insights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reflections: fullReflections, sessions: fullSessions, user_email: userEmail }),
      });
      if (!res.ok) throw new Error('Server error');
      const data = await res.json();
      setFullText(data.feedback ?? '');
    } catch {
      setError('Could not generate insights — make sure the analytics server is running.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if ((fullReflections.length > 0 || fullSessions.length > 0) && !hasTriedRef.current) {
      hasTriedRef.current = true;
      generate();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullReflections.length, fullSessions.length]);

  async function handleAskInsights() {
    const q = chatInput.trim();
    if (!q || chatLoading) return;
    setChatLoading(true);
    const nextLocalHistory: InsightsChatTurn[] = [...chatHistory, { role: 'user', text: q }];
    setChatHistory(nextLocalHistory);
    setChatInput('');
    try {
      const res = await fetch(`${API}/insights/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: q,
          history: chatHistory,
          reflections: fullReflections,
          sessions: fullSessions,
          metrics: buildInsightsMetrics(fullReflections, fullSessions),
          user_email: userEmail,
        }),
      });
      if (!res.ok) throw new Error('Insights chat failed');
      const data = await res.json();
      const replyText =
        (Array.isArray(data.updated_history) && data.updated_history.length > 0
          ? (data.updated_history[data.updated_history.length - 1]?.text ?? '')
          : (data.reply ?? 'No response.'));
      typeAssistantReply(nextLocalHistory, replyText);
    } catch {
      clearChatTypeTimer();
      setChatHistory(prev => [...prev, { role: 'assistant', text: 'Could not answer right now. Please try again.' }]);
    } finally {
      setChatLoading(false);
    }
  }

  // Normalize: ensure every bullet marker starts a new line, then split
  const bullets = displayed
    .replace(/([^\n])\s*•/g, '$1\n•')
    .split('\n')
    .map(l => l.trim().replace(/^[•\-*\d]+[.)]\s*/, ''))
    .filter(l => l.length > 0);

  return (
    <div className="smart-feedback-panel">
      {/* Header */}
      <div style={{
        background: 'linear-gradient(135deg, #1a73e8 0%, #6c47ff 100%)',
        borderRadius: '12px 12px 0 0',
        padding: '18px 20px 14px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>✦</span>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>Smart Insights</span>
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>
            AI coach · based on your data
          </div>
        </div>
        <button
          onClick={() => generate()}
          disabled={loading}
          style={{
            background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)',
            borderRadius: 8, padding: '5px 12px', fontSize: 12, cursor: loading ? 'default' : 'pointer',
            color: '#fff', display: 'flex', alignItems: 'center', gap: 5,
            opacity: loading ? 0.5 : 1, backdropFilter: 'blur(4px)',
          }}
        >
          <span style={{ fontSize: 15, lineHeight: 1 }}>↺</span> Refresh
        </button>
      </div>

      {/* Body */}
      <div style={{
        background: '#fff', border: '1px solid #e8eaed', borderTop: 'none',
        borderRadius: '0 0 12px 12px', padding: '20px 20px 22px',
      }}>
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[90, 72, 84, 60].map((w, i) => (
              <div key={i} style={{ height: 11, background: '#f1f3f4', borderRadius: 6, width: `${w}%`, animation: 'pulse 1.5s ease-in-out infinite' }} />
            ))}
            <div style={{ fontSize: 12, color: '#9aa0a6', marginTop: 6 }}>Analyzing your patterns…</div>
          </div>
        )}

        {error && !loading && (
          <div style={{ fontSize: 13, color: '#ea4335', lineHeight: 1.5 }}>{error}</div>
        )}

        {!loading && !error && bullets.length === 0 && !isTyping && (
          <div style={{ fontSize: 13, color: '#9aa0a6', lineHeight: 1.6 }}>
            Log some sessions and reflections to get personalized coaching insights.
          </div>
        )}

        {bullets.length > 0 && (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column' }}>
            {bullets.map((line, i) => {
              const clean = line.replace(/^[•\-*]\s*/, '');
              const isLast = i === bullets.length - 1;
              return (
                <li key={i} style={{
                  display: 'flex', gap: 14, alignItems: 'flex-start',
                  padding: '14px 0',
                  borderBottom: isLast ? 'none' : '1px solid #f1f3f4',
                }}>
                  <span style={{
                    flexShrink: 0, width: 10, height: 10, borderRadius: '50%', marginTop: 7,
                    background: 'linear-gradient(135deg, #1a73e8, #6c47ff)',
                    boxShadow: '0 1px 4px rgba(26,115,232,0.35)',
                  }} />
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#202124', lineHeight: 1.65 }}>
                    {clean}
                    {isLast && isTyping && (
                      <span style={{ display: 'inline-block', width: 2, height: '1em', background: '#1a73e8', marginLeft: 2, verticalAlign: 'text-bottom', animation: 'blink 0.8s step-end infinite' }} />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <div style={{ marginTop: 16, borderTop: '1px solid #f1f3f4', paddingTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#3c4043', marginBottom: 8 }}>
            Ask Smart Insights
          </div>
          <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
            {chatHistory.length === 0 && (
              <div style={{ fontSize: 12, color: '#9aa0a6' }}>
                Try: "What are my productivity trends by day?" or "Which subject am I underestimating?"
              </div>
            )}
            {chatHistory.map((m, idx) => (
              <div
                key={idx}
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  background: m.role === 'user' ? '#e8f0fe' : '#f8f9fa',
                  color: '#202124',
                  borderRadius: 10,
                  padding: '7px 10px',
                  fontSize: 12,
                  lineHeight: 1.45,
                  maxWidth: '92%',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {m.text}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAskInsights(); }}
              placeholder="Ask about your trends, patterns, or metrics..."
              style={{
                flex: 1,
                border: '1px solid #dadce0',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 12,
              }}
            />
            <button
              onClick={handleAskInsights}
              disabled={chatLoading || !chatInput.trim()}
              style={{
                border: 'none',
                borderRadius: 8,
                padding: '8px 12px',
                fontSize: 12,
                fontWeight: 600,
                color: '#fff',
                background: chatLoading || !chatInput.trim() ? '#bcc0c4' : '#1a73e8',
                cursor: chatLoading || !chatInput.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {chatLoading ? 'Asking…' : 'Ask'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

const API = process.env.REACT_APP_ANALYTICS_API ?? 'http://localhost:8001';

export default function AnalyticsTab({ reflections, sessions = [], userEmail }: { reflections: ReflectionEntry[]; sessions?: CalSession[]; userEmail?: string }) {
  // Use local reflections (in-session) merged with any loaded from Firestore
  const [allReflections, setAllReflections] = useState<ReflectionEntry[]>(reflections);

  useEffect(() => {
    setAllReflections(reflections);
  }, [reflections]);

  const hourData  = byHour(allReflections);
  const dowData   = byDow(allReflections);
  const subjData  = bySubject(sessions, allReflections);
  const locData   = byLocation(allReflections);
  const mcqData   = mcqRows(allReflections);
  const underestData = underestimatedSubjects(allReflections);
  const timingProdData = productivityByTiming(allReflections);

  const hasAnyMcq = allReflections.some(
    r => r.sessionLengthFeedback || r.timingFeedback || r.breaksFeedback
  );

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  const thisWeekSessions = sessions.filter(s => {
    if (!s.date) return false;
    const d = parseISO(s.date);
    return d >= weekStart && d <= weekEnd;
  });
  const thisWeekReflections = allReflections.filter(r => {
    const d = parseISO(r.date);
    return d >= weekStart && d <= weekEnd;
  });

  const totalMins = thisWeekSessions.length > 0
    ? thisWeekSessions.reduce((s, r) => s + r.durationMins, 0)
    : thisWeekReflections.reduce((s, r) => s + sessionDuration(r), 0);

  const peakHour = hourData.reduce<ProdPoint | null>(
    (b, d) => !b || d.avgProductivity > b.avgProductivity ? d : b, null);
  const peakDow = dowData.reduce<ProdPoint | null>(
    (b, d) => !b || d.avgProductivity > b.avgProductivity ? d : b, null);
  const topSubject = subjData[0] ?? null;
  const peakLocation = locData[0] ?? null;

  const timingFitRate   = justRightRate(allReflections, 'timingFeedback', 'good_timing');
  const underestRate    = justRightRate(allReflections, 'sessionLengthFeedback', 'too_short');
  const breaksFitRate   = justRightRate(allReflections, 'breaksFeedback', 'just_right');
  const planAccRate     = justRightRate(allReflections, 'sessionLengthFeedback', 'just_right');

  const empty = allReflections.length === 0 && sessions.length === 0;

  return (
    <div className="analytics-tab">
      <div className="analytics-inner">

        {/* ── Summary cards ── */}
        <div className="analytics-stats-row">
          <StatCard label="Total time logged this week" value={totalMins > 0 ? fmtMins(totalMins) : '—'} />
          <StatCard
            label="Most productive time"
            value={peakHour ? peakHour.label : '—'}
            sub={peakHour ? `avg ${peakHour.avgProductivity.toFixed(1)} / 5` : undefined}
          />
          <StatCard
            label="Most productive day"
            value={peakDow ? peakDow.label : '—'}
            sub={peakDow ? `avg ${peakDow.avgProductivity.toFixed(1)} / 5` : undefined}
          />
          <StatCard
            label="Most time spent on"
            value={topSubject ? topSubject.title : '—'}
            sub={topSubject ? `${fmtMins(topSubject.totalMins)} · ${topSubject.sessionCount} session${topSubject.sessionCount !== 1 ? 's' : ''}` : undefined}
          />
          <StatCard
            label="Most productive location"
            value={peakLocation ? peakLocation.label : '—'}
            sub={peakLocation ? `avg ${peakLocation.avgProductivity.toFixed(1)} / 5 · ${peakLocation.sessionCount} session${peakLocation.sessionCount !== 1 ? 's' : ''}` : undefined}
          />
        </div>

        {empty ? (
          <div className="analytics-chart-panel">
            <div className="analytics-empty">
              <div className="analytics-empty-icon">📊</div>
              <p>No data yet. Log work sessions in the Diary tab and save reflections to see your patterns here.</p>
            </div>
          </div>
        ) : (
          <>
            {/* ── Productivity charts + Smart Feedback side-by-side ── */}
            <div className="analytics-main-grid">
              {/* Left: time of day stacked above day of week */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div className="analytics-chart-panel">
                  <div className="chart-panel-header">
                    <h2 className="chart-title">Productivity by time of day</h2>
                    <span className="chart-subtitle">avg score per starting hour</span>
                  </div>
                  <ProdBarChart data={hourData} yLabel="Avg productivity" />
                </div>

                <div className="analytics-chart-panel">
                  <div className="chart-panel-header">
                    <h2 className="chart-title">Productivity by day of week</h2>
                    <span className="chart-subtitle">avg score per day</span>
                  </div>
                  <ProdBarChart data={dowData} yLabel="Avg productivity" />
                </div>
              </div>

              {/* Right: Smart Feedback Panel */}
              <SmartFeedbackPanel reflections={allReflections} sessions={sessions} userEmail={userEmail} />
            </div>

            {/* ── Subject chart full width ── */}
            <div className="analytics-chart-panel" style={{ marginTop: 16 }}>
              <div className="chart-panel-header">
                <h2 className="chart-title">Time spent by subject</h2>
                <span className="chart-subtitle">total from calendar · color = avg productivity (grey = no reflection yet)</span>
              </div>
              <SubjectChart data={subjData} />
            </div>

            {/* ── Session quality insights ── */}
            {hasAnyMcq && (
              <>
                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <h2 className="chart-title" style={{ fontSize: 16, margin: 0 }}>Session Quality Insights</h2>
                  <span className="chart-subtitle">based on your reflection feedback</span>
                </div>

                {/* MCQ stat cards */}
                <div className="analytics-stats-row" style={{ marginBottom: 0 }}>
                  <StatCard
                    label="Sessions on target length"
                    value={planAccRate !== null ? `${Math.round(planAccRate * 100)}%` : '—'}
                    sub="length felt just right"
                  />
                  <StatCard
                    label="Underestimated sessions"
                    value={underestRate !== null ? `${Math.round(underestRate * 100)}%` : '—'}
                    sub="felt too short"
                  />
                  <StatCard
                    label="Well-timed sessions"
                    value={timingFitRate !== null ? `${Math.round(timingFitRate * 100)}%` : '—'}
                    sub="timing felt right"
                  />
                  <StatCard
                    label="Breaks just right"
                    value={breaksFitRate !== null ? `${Math.round(breaksFitRate * 100)}%` : '—'}
                    sub="break balance on point"
                  />
                </div>

                {/* MCQ breakdown + underestimated subjects */}
                <div className="analytics-two-col" style={{ marginTop: 16 }}>
                  <div className="analytics-chart-panel">
                    <div className="chart-panel-header">
                      <h2 className="chart-title">Feedback breakdown</h2>
                      <span className="chart-subtitle">distribution across all reflections</span>
                    </div>
                    <McqStackedBars rows={mcqData} />
                  </div>

                  <div className="analytics-chart-panel">
                    <div className="chart-panel-header">
                      <h2 className="chart-title">Most underestimated subjects</h2>
                      <span className="chart-subtitle">% sessions that felt too short · min 2 reflections</span>
                    </div>
                    <UnderestimatedChart data={underestData} />
                  </div>
                </div>

                {/* Productivity by timing */}
                {timingProdData.length > 0 && (
                  <div className="analytics-chart-panel" style={{ marginTop: 16 }}>
                    <div className="chart-panel-header">
                      <h2 className="chart-title">Does timing affect productivity?</h2>
                      <span className="chart-subtitle">avg productivity score by timing feedback</span>
                    </div>
                    <TimingProdChart data={timingProdData} />
                  </div>
                )}
              </>
            )}

            {/* ── Productivity by location ── */}
            {locData.length > 0 && (
              <div className="analytics-chart-panel" style={{ marginTop: 16 }}>
                <div className="chart-panel-header">
                  <h2 className="chart-title">Productivity by location</h2>
                  <span className="chart-subtitle">avg score per session location</span>
                </div>
                <ProdBarChart data={locData} yLabel="Avg productivity" />
              </div>
            )}

            {/* ── All sessions table ── */}
            <div className="analytics-chart-panel" style={{ marginTop: 16 }}>
              <div className="chart-panel-header">
                <h2 className="chart-title">All sessions</h2>
                <span style={{ fontSize: 13, color: '#9aa0a6' }}>{allReflections.length} total</span>
              </div>
              <div className="sessions-table-wrap">
                <table className="sessions-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Title</th>
                      <th>Location</th>
                      <th>Time</th>
                      <th>Duration</th>
                      <th>Productivity</th>
                      <th>Length</th>
                      <th>Timing</th>
                      <th>Breaks</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...allReflections].reverse().map(r => (
                      <tr key={r.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{format(parseISO(r.date), 'MMM d, yyyy')}</td>
                        <td className="td-title">{r.title}</td>
                        <td style={{ fontSize: 12, color: '#5f6368' }}>{r.location || '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.startTime} – {r.endTime}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtMins(sessionDuration(r))}</td>
                        <td style={{ textAlign: 'center' }}>
                          <span className="prod-badge" style={{ background: PRODUCTIVITY_COLOR(r.productivity) }}>
                            {FACE[r.productivity]} {r.productivity}
                          </span>
                        </td>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: '#5f6368' }}>
                          {r.sessionLengthFeedback ? r.sessionLengthFeedback.replace(/_/g, ' ') : '—'}
                        </td>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: '#5f6368' }}>
                          {r.timingFeedback ? r.timingFeedback.replace(/_/g, ' ') : '—'}
                        </td>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: '#5f6368' }}>
                          {r.breaksFeedback ? r.breaksFeedback.replace(/_/g, ' ') : '—'}
                        </td>
                        <td className="td-reflection">{r.reflectionText}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
