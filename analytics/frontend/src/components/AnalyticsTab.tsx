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
interface SubjectPoint { title: string; totalMins: number; sessionCount: number; avgProductivity: number; }

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

function bySubject(reflections: ReflectionEntry[]): SubjectPoint[] {
  const g: Record<string, { mins: number[]; prods: number[] }> = {};
  for (const r of reflections) {
    if (!g[r.title]) g[r.title] = { mins: [], prods: [] };
    g[r.title].mins.push(sessionDuration(r));
    g[r.title].prods.push(r.productivity);
  }
  return Object.entries(g)
    .map(([title, { mins, prods }]) => ({
      title,
      totalMins: mins.reduce((a, b) => a + b, 0),
      sessionCount: mins.length,
      avgProductivity: prods.reduce((a, b) => a + b, 0) / prods.length,
    }))
    .sort((a, b) => b.totalMins - a.totalMins)
    .slice(0, 12);
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

  const H = 240, mg = { top: 20, right: 20, bottom: 44, left: 46 };
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
                  fill={PRODUCTIVITY_COLOR(d.avgProductivity)}
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

export default function AnalyticsTab({ reflections }: { reflections: ReflectionEntry[] }) {
  const hourData  = byHour(reflections);
  const dowData   = byDow(reflections);
  const subjData  = bySubject(reflections);

  const totalMins = reflections.reduce((s, r) => s + sessionDuration(r), 0);

  const peakHour = hourData.reduce<ProdPoint | null>(
    (b, d) => !b || d.avgProductivity > b.avgProductivity ? d : b, null);
  const peakDow = dowData.reduce<ProdPoint | null>(
    (b, d) => !b || d.avgProductivity > b.avgProductivity ? d : b, null);
  const topSubject = subjData[0] ?? null;

  const empty = reflections.length === 0;

  return (
    <div className="analytics-tab">
      <div className="analytics-inner">

        {/* ── Summary cards ── */}
        <div className="analytics-stats-row">
          <StatCard label="Total time logged" value={totalMins > 0 ? fmtMins(totalMins) : '—'} />
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
            {/* ── Row: time-of-day + day-of-week ── */}
            <div className="analytics-two-col">
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

            {/* ── Subject chart ── */}
            <div className="analytics-chart-panel" style={{ marginTop: 16 }}>
              <div className="chart-panel-header">
                <h2 className="chart-title">Time spent by subject</h2>
                <span className="chart-subtitle">total logged · bar color = avg productivity</span>
              </div>
              <SubjectChart data={subjData} />
            </div>

            {/* ── All sessions table ── */}
            <div className="analytics-chart-panel" style={{ marginTop: 16 }}>
              <div className="chart-panel-header">
                <h2 className="chart-title">All sessions</h2>
                <span style={{ fontSize: 13, color: '#9aa0a6' }}>{reflections.length} total</span>
              </div>
              <div className="sessions-table-wrap">
                <table className="sessions-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Title</th>
                      <th>Time</th>
                      <th>Duration</th>
                      <th>Productivity</th>
                      <th>Reflection</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...reflections].reverse().map(r => (
                      <tr key={r.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{format(parseISO(r.date), 'MMM d, yyyy')}</td>
                        <td className="td-title">{r.title}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.startTime} – {r.endTime}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtMins(sessionDuration(r))}</td>
                        <td style={{ textAlign: 'center' }}>
                          <span className="prod-badge" style={{ background: PRODUCTIVITY_COLOR(r.productivity) }}>
                            {FACE[r.productivity]} {r.productivity}
                          </span>
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
