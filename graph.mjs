// --graph: interactive terminal chart of the recorded usage history (Ink + React, no build step).
import { createRequire } from 'node:module';
import React, { useEffect, useState } from 'react';
import { Box, Text, render, renderToString, useApp, useInput, useWindowSize } from 'ink';

const require = createRequire(import.meta.url);
const { analyzeMeter, project, projectionRate, meterStats, loadHistory, formatDuration, formatTime, formatDay, HOUR, DAY } = require('./codex-balance.js');

const h = React.createElement;
const RANGES = [
  { label: '6h', seconds: 6 * HOUR },
  { label: '24h', seconds: DAY },
  { label: '7d', seconds: 7 * DAY },
  { label: '30d', seconds: 30 * DAY },
];
const DEFAULT_RANGE = { '5h': 1, month: 3 };
// Samples further apart than this (or 3x the usual poll interval) are a gap: the laptop was asleep.
const MIN_GAP_SECONDS = 30 * 60;
const RELOAD_MS = 30 * 1000;
const SIDEBAR_WIDTH = 35;
const SPARK_WIDTH = 8;
const Y_AXIS_WIDTH = 5;
const TICK_STEPS = [15 * 60, 30 * 60, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];

function levelColor(remaining) {
  if (remaining > 50) return 'green';
  if (remaining > 20) return 'yellow';
  return 'red';
}

function gapSeconds(samples) {
  const intervals = samples.slice(1).map((sample, i) => sample.created_at - samples[i].created_at).sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)] || 0;
  return Math.max(MIN_GAP_SECONDS, median * 3);
}

// Braille canvas: each terminal cell holds a 2x4 dot grid. Every dot remembers the
// layer that drew it; a cell takes the colour of its highest-priority layer.
// Text labels replace whole cells.
const DOT_BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

class Canvas {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.width = cols * 2;
    this.height = rows * 4;
    this.bits = new Uint8Array(cols * rows);
    this.layer = new Array(cols * rows).fill(null);
    this.label = new Array(cols * rows).fill(null);
  }

  dot(x, y, layer) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const cell = Math.floor(y / 4) * this.cols + Math.floor(x / 2);
    this.bits[cell] |= DOT_BITS[y % 4][x % 2];
    if (!this.layer[cell] || layer.priority > this.layer[cell].priority) this.layer[cell] = layer;
  }

  // dash: draw `on` dots, skip `off` dots (0 = solid).
  line(x0, y0, x1, y1, layer, { on = 1, off = 0 } = {}) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i += 1) {
      if (off && i % (on + off) >= on) continue;
      this.dot(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, layer);
    }
  }

  vertical(x, layer, dash) {
    this.line(x, 0, x, this.height - 1, layer, dash);
  }

  // Place text at a cell, shifted left to fit; skipped if it would cover another label.
  text(col, row, string, color) {
    if (row < 0 || row >= this.rows || string.length > this.cols) return;
    const start = Math.max(0, Math.min(col, this.cols - string.length));
    const cells = [...string].map((_, i) => row * this.cols + start + i);
    if (cells.some((cell) => this.label[cell])) return;
    cells.forEach((cell, i) => { this.label[cell] = { char: string[i], color }; });
  }

  // Rows of [text, color] runs, merged where neighbouring cells share a colour.
  runs() {
    const rows = [];
    for (let row = 0; row < this.rows; row += 1) {
      const runs = [];
      for (let col = 0; col < this.cols; col += 1) {
        const cell = row * this.cols + col;
        const label = this.label[cell];
        const char = label ? label.char : this.bits[cell] ? String.fromCharCode(0x2800 + this.bits[cell]) : ' ';
        const color = label ? label.color : this.layer[cell]?.color;
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
  reset: { priority: 0, color: 'magenta' },
  now: { priority: 1, color: 'white' },
  budget: { priority: 2, color: 'blue' },
  gap: { priority: 3, color: 'gray' },
  projectionOk: { priority: 4, color: 'yellow' },
  projectionOut: { priority: 4, color: 'red' },
  history: { priority: 5, color: 'cyan' },
};
const DOTTED = { on: 1, off: 2 };

// Time domain: the range back from now, plus enough future to show the next reset when it is close.
function domain(meter, range, now) {
  let future = range.seconds / 4;
  const untilReset = meter.resetsAt ? meter.resetsAt - now : null;
  if (untilReset && untilReset <= range.seconds * 0.6) future = Math.max(range.seconds / 8, untilReset * 1.06);
  return { t0: now - range.seconds, t1: now + future };
}

function plot(meter, samples, range, now, cols, rows) {
  const canvas = new Canvas(cols, rows);
  const { t0, t1 } = domain(meter, range, now);
  const x = (t) => ((t - t0) / (t1 - t0)) * (canvas.width - 1);
  const y = (remaining) => (1 - remaining / 100) * (canvas.height - 1);
  const shown = new Set();
  const inView = (t) => t >= t0 && t <= t1;

  for (const reset of meter.resets) {
    if (!inView(reset)) continue;
    canvas.vertical(x(reset), LAYERS.reset, DOTTED);
    shown.add('reset');
  }
  canvas.vertical(x(now), LAYERS.now, { on: 1, off: 1 });

  // Even pace across the current window: staying above this line means staying within budget.
  if (meter.resetsAt && meter.windowStart) {
    canvas.line(x(meter.windowStart), y(100), x(meter.resetsAt), y(0), LAYERS.budget, DOTTED);
    shown.add('budget');
  }

  const outcome = project(meter, projectionRate(meter));
  if (outcome && outcome.kind !== 'idle') {
    const layer = outcome.kind === 'runsOut' ? LAYERS.projectionOut : LAYERS.projectionOk;
    const { latest } = meter;
    canvas.line(x(latest.created_at), y(latest.remaining_pct), x(outcome.at), y(outcome.remaining), layer, { on: 2, off: 1 });
    if (outcome.kind === 'runsOut' && meter.resetsAt) canvas.line(x(outcome.at), y(0), x(meter.resetsAt), y(0), layer, { on: 2, off: 1 });
    shown.add(outcome.kind);

    // Label the outcome where the projection ends (or leaves the chart).
    const endT = Math.min(outcome.at, t1);
    const endRemaining = latest.remaining_pct + ((outcome.remaining - latest.remaining_pct) * (endT - latest.created_at)) / (outcome.at - latest.created_at || 1);
    const text = outcome.kind === 'lasts' ? `${Math.round(outcome.remaining)}% at reset` : `empty ${formatTime(outcome.at, now)}`;
    const col = Math.round(x(endT) / 2);
    const row = Math.floor(y(endRemaining) / 4);
    canvas.text(col + 1, row > 0 ? row - 1 : row + 1, text, layer.color);
  }

  const gap = gapSeconds(samples);
  const visible = samples.filter((sample) => sample.created_at >= t0 - gap);
  visible.forEach((sample, i) => {
    const previous = visible[i - 1];
    const from = [x(previous?.created_at), y(previous?.remaining_pct)];
    const to = [x(sample.created_at), y(sample.remaining_pct)];
    if (!previous) canvas.dot(...to, LAYERS.history);
    else if (sample.created_at - previous.created_at <= gap) canvas.line(...from, ...to, LAYERS.history);
    else {
      // Asleep: the change happened somewhere in between, so only hint at the connection.
      canvas.line(...from, ...to, LAYERS.gap, DOTTED);
      shown.add('gap');
    }
  });

  return { runs: canvas.runs(), t0, t1, shown };
}

// Round tick times (local hours, midnights, days) at a spacing that leaves room for the labels.
function ticks(t0, t1, cols) {
  const maxTicks = Math.max(2, Math.floor(cols / 9));
  const step = TICK_STEPS.find((candidate) => (t1 - t0) / candidate <= maxTicks) || TICK_STEPS[TICK_STEPS.length - 1];
  const start = new Date(t0 * 1000);
  start.setHours(0, 0, 0, 0);
  if (step === 7 * DAY) start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Mondays
  const result = [];
  for (const cursor = new Date(start); cursor.getTime() / 1000 <= t1;) {
    const t = cursor.getTime() / 1000;
    if (t >= t0) {
      const midnight = cursor.getHours() === 0 && cursor.getMinutes() === 0;
      let label;
      if (step >= DAY) label = formatDay(t);
      else if (midnight) label = cursor.toLocaleDateString('en-GB', { weekday: 'short' });
      else label = formatTime(t, t);
      result.push({ t, label, major: midnight });
    }
    if (step >= DAY) cursor.setDate(cursor.getDate() + step / DAY);
    else cursor.setTime(cursor.getTime() + step * 1000);
  }
  return result;
}

// An axis line with ┬ at each tick and the labels underneath; "now" wins over overlapping labels.
function xAxis(t0, t1, cols, now) {
  const column = (t) => Math.round(((t - t0) / (t1 - t0)) * (cols - 1));
  const axis = new Array(cols).fill('─');
  const labels = new Array(cols).fill(' ');
  const place = (col, label) => {
    const start = Math.min(Math.max(0, col - Math.floor(label.length / 2)), cols - label.length);
    if (labels.slice(Math.max(0, start - 1), start + label.length + 1).some((char) => char !== ' ')) return;
    for (let j = 0; j < label.length; j += 1) labels[start + j] = label[j];
  };
  const nowCol = column(now);
  axis[nowCol] = '┴';
  place(nowCol, 'now');
  for (const tick of ticks(t0, t1, cols)) {
    const col = column(tick.t);
    if (col !== nowCol) axis[col] = tick.major ? '┼' : '┬';
    place(col, tick.label);
  }
  return { axis: axis.join(''), labels: labels.join('') };
}

function Legend({ shown }) {
  const items = [['cyan', '━ used'], ...[
    ['gap', 'gray', '┄ asleep'],
    ['lasts', 'yellow', '┄ projection'],
    ['runsOut', 'red', '┄ runs out'],
    ['budget', 'blue', '┄ even pace'],
    ['reset', 'magenta', '┆ reset'],
  ].filter(([key]) => shown.has(key)).map(([, color, text]) => [color, text]), ['white', '┆ now']];
  return h(Text, { wrap: 'truncate' }, ...items.map(([color, text], i) => h(Text, { key: i, color }, `${text}   `)));
}

function Chart({ entry, range, now, width, height }) {
  const meter = analyzeMeter(entry.window, entry.samples, now);
  const [title, ...details] = meterStats(entry.provider, entry.window, entry.samples, now);
  const cols = Math.max(10, width - Y_AXIS_WIDTH - 4);
  const rows = Math.max(4, height - details.length - 7);
  const { runs, t0, t1, shown } = plot(meter, entry.samples, range, now, cols, rows);
  const { axis, labels } = xAxis(t0, t1, cols, now);
  const yLabel = (row) => {
    for (const value of [100, 75, 50, 25, 0]) {
      if (Math.round((1 - value / 100) * (rows - 1)) === row) return `${value}`.padStart(3) + ' ┤';
    }
    return '    │';
  };
  const titleColor = meter.resetSince ? 'gray' : levelColor(meter.latest.remaining_pct);
  return h(Box, { flexDirection: 'column', flexGrow: 1, borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
    h(Text, { bold: true, color: titleColor, wrap: 'truncate' }, title),
    ...runs.map((row, i) => h(Text, { key: i, wrap: 'truncate' },
      h(Text, { color: 'gray' }, yLabel(i)),
      ...row.map(([text, color], j) => h(Text, { key: j, color }, text)))),
    h(Text, { color: 'gray', wrap: 'truncate' }, `    └${axis}`),
    h(Text, { color: 'gray', wrap: 'truncate' }, `${' '.repeat(Y_AXIS_WIDTH)}${labels}`),
    h(Legend, { shown }),
    ...details.map((line, i) => h(Text, { key: `d${i}`, wrap: 'truncate' }, line.trim())));
}

const SPARKS = '▁▂▃▄▅▆▇█';

// Last 24h in SPARK_WIDTH buckets, the latest reading in each; blank where there was none.
function sparkline(samples, now) {
  const bucket = DAY / SPARK_WIDTH;
  const values = new Array(SPARK_WIDTH).fill(null);
  for (const sample of samples) {
    const index = Math.floor((sample.created_at - (now - DAY)) / bucket);
    if (index >= 0 && index < SPARK_WIDTH) values[index] = sample.remaining_pct;
  }
  return values.map((value) => (value === null ? ' ' : SPARKS[Math.min(7, Math.floor((value / 100) * 8))])).join('');
}

function Sidebar({ meters, selected, now }) {
  return h(Box, { flexDirection: 'column', width: SIDEBAR_WIDTH, flexShrink: 0, borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
    h(Text, { bold: true }, 'Meters', h(Text, { color: 'gray', bold: false }, `${' '.repeat(12)}last 24h`)),
    ...meters.map(({ provider, window, samples }, i) => {
      const meter = analyzeMeter(window, samples, now);
      const { latest } = meter;
      const outcome = project(meter, projectionRate(meter));
      const stale = meter.resetSince || now - latest.created_at > 30 * 60;
      const color = stale ? 'gray' : levelColor(latest.remaining_pct);
      let flag = ' ';
      if (meter.resetSince) flag = '↺';
      else if (outcome?.kind === 'runsOut' || latest.remaining_pct <= 0) flag = '!';
      return h(Box, { key: `${provider}/${window}` },
        h(Text, { inverse: i === selected, wrap: 'truncate' }, `${i === selected ? '›' : ' '} ${`${provider} ${window}`.padEnd(15)}`),
        h(Text, { color }, sparkline(samples, now)),
        h(Text, { color }, ` ${String(Math.round(latest.remaining_pct)).padStart(3)}%`),
        h(Text, { color: flag === '!' ? 'red' : 'gray', bold: true }, flag));
    }));
}

function Footer({ range, loadedAt }) {
  return h(Text, { color: 'gray', wrap: 'truncate' },
    ` ↑↓/jk meter · ←→/hl range: ${RANGES.map((r) => (r === range ? `[${r.label}]` : r.label)).join(' ')} · r reload · q quit · history read ${formatDuration(Date.now() / 1000 - loadedAt)} ago`);
}

function Layout({ meters, selected, range, now, loadedAt, columns, rows }) {
  const entry = meters[Math.min(selected, meters.length - 1)];
  const sidebar = columns >= 90;
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
    // Not interactive (piped, cron): print one static chart per meter instead.
    const now = Math.floor(Date.now() / 1000);
    const columns = Math.max(60, process.stdout.columns || 100);
    for (const entry of initial.meters) {
      const range = rangeFor({}, entry);
      console.log(renderToString(h(Chart, { entry, range, now, width: columns, height: 24 }), { columns }));
    }
    return;
  }
  const app = render(h(App, { names, initial }), { alternateScreen: true });
  await app.waitUntilExit();
}
