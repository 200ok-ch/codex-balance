// --graph: interactive terminal chart of the recorded usage history (Ink + React, no build step).
import { createRequire } from 'node:module';
import React, { useEffect, useState } from 'react';
import { Box, Text, render, renderToString, useApp, useInput, useWindowSize } from 'ink';

const require = createRequire(import.meta.url);
const { analyzeMeter, project, meterStats, loadHistory, formatDuration, formatTime, formatDay, HOUR, DAY } = require('./codex-balance.js');

const h = React.createElement;
const RANGES = [
  { label: '6h', seconds: 6 * HOUR },
  { label: '24h', seconds: DAY },
  { label: '7d', seconds: 7 * DAY },
  { label: '30d', seconds: 30 * DAY },
];
const DEFAULT_RANGE = { '5h': 1, month: 3 };
// Samples further apart than this are a gap (laptop asleep); the line breaks instead of bridging it.
const GAP_SECONDS = 30 * 60;
const RELOAD_MS = 30 * 1000;
const SIDEBAR_WIDTH = 31;
const Y_AXIS_WIDTH = 5;

function levelColor(remaining) {
  if (remaining > 50) return 'green';
  if (remaining > 20) return 'yellow';
  return 'red';
}

// Braille canvas: each terminal cell holds a 2x4 dot grid. Every dot remembers the
// layer that drew it; a cell takes the colour of its highest-priority layer.
const DOT_BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

class Canvas {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.width = cols * 2;
    this.height = rows * 4;
    this.bits = new Uint8Array(cols * rows);
    this.layer = new Array(cols * rows).fill(null);
  }

  dot(x, y, layer) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const cell = Math.floor(y / 4) * this.cols + Math.floor(x / 2);
    this.bits[cell] |= DOT_BITS[y % 4][x % 2];
    if (!this.layer[cell] || layer.priority > this.layer[cell].priority) this.layer[cell] = layer;
  }

  line(x0, y0, x1, y1, layer, dotted = false) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i += 1) {
      if (dotted && i % 3) continue;
      this.dot(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, layer);
    }
  }

  // Rows of [text, color] runs, merged where neighbouring cells share a colour.
  runs() {
    const rows = [];
    for (let row = 0; row < this.rows; row += 1) {
      const runs = [];
      for (let col = 0; col < this.cols; col += 1) {
        const cell = row * this.cols + col;
        const char = this.bits[cell] ? String.fromCharCode(0x2800 + this.bits[cell]) : ' ';
        const color = this.layer[cell]?.color;
        const last = runs[runs.length - 1];
        if (last && last[1] === color) last[0] += char;
        else runs.push([char, color]);
      }
      rows.push(runs);
    }
    return rows;
  }
}

const LAYERS = {
  marker: { priority: 0, color: 'gray' },
  budget: { priority: 1, color: 'blue' },
  projectionOk: { priority: 2, color: 'yellow' },
  projectionOut: { priority: 2, color: 'red' },
  history: { priority: 3, color: 'cyan' },
};

function plot(meter, samples, range, now, cols, rows) {
  const canvas = new Canvas(cols, rows);
  // A quarter of the chart looks ahead, so projections and the next reset are visible.
  const t0 = now - range.seconds;
  const t1 = now + range.seconds / 3;
  const x = (t) => ((t - t0) / (t1 - t0)) * (canvas.width - 1);
  const y = (remaining) => (1 - remaining / 100) * (canvas.height - 1);
  const vertical = (t, layer) => {
    if (t < t0 || t > t1) return;
    for (let py = 0; py < canvas.height; py += 2) canvas.dot(x(t), py, layer);
  };

  // Resets: every distinct reset time seen, plus the upcoming one.
  const resets = new Set(samples.map((sample) => sample.resets_at).filter(Boolean));
  for (const reset of resets) vertical(reset, LAYERS.marker);
  vertical(now, LAYERS.marker);

  // Even pace across the current window: above this line means under budget.
  if (meter.resetsAt && meter.windowSeconds) {
    const start = meter.resetsAt - meter.windowSeconds;
    canvas.line(x(start), y(100), x(meter.resetsAt), y(0), LAYERS.budget, true);
  }

  const outcome = project(meter, meter.cycle?.rate ?? meter.trailing?.rate);
  if (outcome && outcome.kind !== 'idle') {
    const layer = outcome.kind === 'runsOut' ? LAYERS.projectionOut : LAYERS.projectionOk;
    const { latest } = meter;
    canvas.line(x(latest.created_at), y(latest.remaining_pct), x(outcome.at), y(outcome.remaining), layer, true);
    if (outcome.kind === 'runsOut' && meter.resetsAt) canvas.line(x(outcome.at), y(0), x(meter.resetsAt), y(0), layer, true);
  }

  const visible = samples.filter((sample) => sample.created_at >= t0 - GAP_SECONDS);
  visible.forEach((sample, i) => {
    const previous = visible[i - 1];
    if (previous && sample.created_at - previous.created_at <= GAP_SECONDS) {
      canvas.line(x(previous.created_at), y(previous.remaining_pct), x(sample.created_at), y(sample.remaining_pct), LAYERS.history);
    } else {
      canvas.dot(x(sample.created_at), y(sample.remaining_pct), LAYERS.history);
    }
  });

  return { runs: canvas.runs(), t0, t1 };
}

function tickLabel(t, range) {
  if (range.seconds <= DAY) return formatTime(t, t);
  return formatDay(t);
}

// X-axis labels: "now" first, then evenly spaced times, skipping any that would overlap.
function xAxis(t0, t1, cols, range, now) {
  const chars = new Array(cols).fill(' ');
  const column = (t) => Math.round(((t - t0) / (t1 - t0)) * (cols - 1));
  const place = (col, label) => {
    const start = Math.min(Math.max(0, col - Math.floor(label.length / 2)), cols - label.length);
    if (chars.slice(Math.max(0, start - 1), start + label.length + 1).some((char) => char !== ' ')) return;
    for (let j = 0; j < label.length; j += 1) chars[start + j] = label[j];
  };
  place(column(now), 'now');
  const ticks = 5;
  for (let i = 0; i <= ticks; i += 1) {
    const col = Math.round((i / ticks) * (cols - 1));
    place(col, tickLabel(t0 + ((t1 - t0) * col) / (cols - 1), range));
  }
  return chars.join('');
}

function Sidebar({ meters, selected, now }) {
  return h(Box, { flexDirection: 'column', width: SIDEBAR_WIDTH, flexShrink: 0, borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
    h(Text, { bold: true }, 'Meters'),
    ...meters.map(({ provider, window, samples }, i) => {
      const latest = samples[samples.length - 1];
      const filled = Math.round(latest.remaining_pct / 20);
      const stale = now - latest.created_at > 30 * 60;
      return h(Box, { key: `${provider}/${window}` },
        h(Text, { inverse: i === selected, wrap: 'truncate' }, `${i === selected ? '›' : ' '} ${`${provider} ${window}`.padEnd(15)}`),
        h(Text, { color: stale ? 'gray' : levelColor(latest.remaining_pct) }, `${'█'.repeat(filled)}${'░'.repeat(5 - filled)}`),
        h(Text, { dimColor: stale }, ` ${String(Math.round(latest.remaining_pct)).padStart(3)}%`));
    }));
}

function Chart({ entry, range, now, width, height }) {
  const meter = analyzeMeter(entry.window, entry.samples, now);
  const [title, ...details] = meterStats(entry.provider, entry.window, entry.samples, now);
  const cols = Math.max(10, width - Y_AXIS_WIDTH - 4);
  const rows = Math.max(4, height - details.length - 6);
  const { runs, t0, t1 } = plot(meter, entry.samples, range, now, cols, rows);
  const yLabel = (row) => {
    for (const value of [100, 75, 50, 25, 0]) {
      if (Math.round((1 - value / 100) * (rows - 1)) === row) return `${value}`.padStart(3) + ' ┤';
    }
    return '    │';
  };
  return h(Box, { flexDirection: 'column', flexGrow: 1, borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
    h(Text, { bold: true, color: levelColor(meter.latest.remaining_pct), wrap: 'truncate' }, title),
    ...runs.map((row, i) => h(Text, { key: i, wrap: 'truncate' },
      h(Text, { color: 'gray' }, yLabel(i)),
      ...row.map(([text, color], j) => h(Text, { key: j, color }, text)))),
    h(Text, { color: 'gray', wrap: 'truncate' }, `${' '.repeat(Y_AXIS_WIDTH)}${xAxis(t0, t1, cols, range, now)}`),
    h(Text, { wrap: 'truncate' },
      h(Text, { color: 'cyan' }, '━ remaining  '),
      h(Text, { color: 'yellow' }, '┅ projection  '),
      h(Text, { color: 'blue' }, '┅ even pace  '),
      h(Text, { color: 'gray' }, '┆ reset / now')),
    ...details.map((line, i) => h(Text, { key: `d${i}`, wrap: 'truncate' }, line.trim())));
}

function Footer({ range, loadedAt }) {
  return h(Text, { color: 'gray', wrap: 'truncate' },
    ` ↑↓/jk meter · ←→/hl range: ${RANGES.map((r) => (r === range ? `[${r.label}]` : r.label)).join(' ')} · r reload · q quit · history read ${formatDuration(Date.now() / 1000 - loadedAt)} ago`);
}

function Layout({ meters, selected, range, now, loadedAt, columns, rows }) {
  const entry = meters[Math.min(selected, meters.length - 1)];
  const sidebar = columns >= 80;
  return h(Box, { flexDirection: 'column', width: columns, height: rows },
    h(Box, { flexGrow: 1 },
      sidebar ? h(Sidebar, { meters, selected, now }) : null,
      h(Chart, { entry, range, now, width: columns - (sidebar ? SIDEBAR_WIDTH : 0), height: rows - 1 })),
    h(Footer, { range, loadedAt }));
}

function rangeFor(choice, entry) {
  return RANGES[choice[`${entry.provider}/${entry.window}`] ?? DEFAULT_RANGE[entry.window] ?? 2];
}

function App({ names, initial }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [history, setHistory] = useState(initial);
  const [selected, setSelected] = useState(0);
  const [choice, setChoice] = useState({});
  const [clock, setClock] = useState(Date.now());

  const reload = () => {
    try {
      setHistory({ meters: loadHistory(names), loadedAt: Date.now() / 1000 });
    } catch {
      // Keep showing the last good read; polybar may be mid-write.
    }
  };
  useEffect(() => {
    const timer = setInterval(() => { reload(); setClock(Date.now()); }, RELOAD_MS);
    return () => clearInterval(timer);
  }, []);

  const { meters } = history;
  const entry = meters[Math.min(selected, meters.length - 1)];
  const range = rangeFor(choice, entry);
  useInput((input, key) => {
    if (input === 'q' || key.escape) exit();
    else if (key.upArrow || input === 'k') setSelected((i) => (i - 1 + meters.length) % meters.length);
    else if (key.downArrow || input === 'j') setSelected((i) => (i + 1) % meters.length);
    else if (key.leftArrow || input === 'h' || key.rightArrow || input === 'l') {
      const step = key.leftArrow || input === 'h' ? -1 : 1;
      const next = Math.max(0, Math.min(RANGES.length - 1, RANGES.indexOf(range) + step));
      setChoice((current) => ({ ...current, [`${entry.provider}/${entry.window}`]: next }));
    } else if (input === 'r') {
      reload();
      setClock(Date.now());
    }
  });

  return h(Layout, { meters, selected, range, now: Math.floor(clock / 1000), loadedAt: history.loadedAt, columns, rows });
}

export async function run(names) {
  const initial = { meters: loadHistory(names), loadedAt: Date.now() / 1000 };
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // Not interactive (piped, cron): print one static frame per meter instead.
    const now = Math.floor(Date.now() / 1000);
    const columns = Math.max(60, process.stdout.columns || 100);
    for (const entry of initial.meters) {
      const range = rangeFor({}, entry);
      console.log(renderToString(h(Chart, { entry, range, now, width: columns, height: 22 }), { columns }));
    }
    return;
  }
  const app = render(h(App, { names, initial }), { alternateScreen: true });
  await app.waitUntilExit();
}
