// Icon generator: one geometry, three surfaces.
//
//   resources/icon.svg        monochrome mark for the activity bar container (24x24, currentColor)
//   resources/icon.png        128x128 badge for the Marketplace listing and the editor tab
//   resources/icon-editor-*.svg  the same mark with a FIXED color, for the editor tab bar button
//                             (a path icon is painted as an image there, so currentColor is no use)
//
// Both files are generated from MARKS below, so the sidebar icon and the badge can never
// drift apart. Zero dependencies: the badge is rasterized with signed-distance functions
// and encoded as PNG with Node's zlib.
//
//   node scripts/make-icon.mjs            # regenerate resources/icon.{svg,png}
//   node scripts/make-icon.mjs --preview  # also drop a preview sheet in the OS temp dir
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The design grid. Everything below is expressed on it, in the same units as a 24x24
// icon: a rounded speech bubble with a terminal prompt (`>` and `_`) inside — the bubble
// is the agent conversation, the prompt says these are coding agents.
const GRID = 24;
const STROKE = 1.6;
const MARK_BOX = { x0: 3.75, y0: 4.25, x1: 20.25, y1: 19.5 };

// Angles are screen-space: 0° points right, 90° points down, so arc sweeps read
// clockwise, matching SVG's sweep-flag 1.
const MARKS = [
  line(6.5, 4.25, 17.5, 4.25),
  arc(17.5, 7, 2.75, 270, 360),
  line(20.25, 7, 20.25, 12.5),
  arc(17.5, 12.5, 2.75, 0, 90),
  line(17.5, 15.25, 9.75, 15.25),
  line(9.75, 15.25, 6.5, 19.5),
  line(6.5, 19.5, 6.5, 15.25),
  arc(6.5, 12.5, 2.75, 90, 180),
  line(3.75, 12.5, 3.75, 7),
  arc(6.5, 7, 2.75, 180, 270),
  line(8.5, 8, 10.5, 9.75),
  line(10.5, 9.75, 8.5, 11.5),
  line(12.5, 11.5, 15.5, 11.5),
];

function line(ax, ay, bx, by) { return { kind: 'line', ax, ay, bx, by }; }
function arc(cx, cy, r, from, to) { return { kind: 'arc', cx, cy, r, from, to }; }

// --- geometry ---------------------------------------------------------------

function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function onArc(a, px, py) {
  const sweep = ((a.to - a.from) % 360 + 360) % 360;
  const angle = ((Math.atan2(py - a.cy, px - a.cx) * 180 / Math.PI) % 360 + 360) % 360;
  const delta = ((angle - a.from) % 360 + 360) % 360;
  return delta <= sweep;
}

function markDistance(px, py) {
  let best = Infinity;
  for (const m of MARKS) {
    if (m.kind === 'line') {
      best = Math.min(best, pointSegmentDistance(px, py, m.ax, m.ay, m.bx, m.by));
      continue;
    }
    if (onArc(m, px, py)) {
      best = Math.min(best, Math.abs(Math.hypot(px - m.cx, py - m.cy) - m.r));
    } else {
      const a = (m.from * Math.PI) / 180, b = (m.to * Math.PI) / 180;
      best = Math.min(
        best,
        Math.hypot(px - (m.cx + m.r * Math.cos(a)), py - (m.cy + m.r * Math.sin(a))),
        Math.hypot(px - (m.cx + m.r * Math.cos(b)), py - (m.cy + m.r * Math.sin(b))),
      );
    }
  }
  return best - STROKE / 2;
}

function roundedBoxDistance(px, py, halfW, halfH, radius) {
  const qx = Math.abs(px - halfW) - (halfW - radius);
  const qy = Math.abs(py - halfH) - (halfH - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const coverage = (distancePx) => Math.max(0, Math.min(1, 0.5 - distancePx));

// --- rendering --------------------------------------------------------------

const BADGE_FROM = [0x3b, 0x82, 0xf6];
const BADGE_TO = [0x7c, 0x3a, 0xed];
const BADGE_RADIUS_RATIO = 0.22;
// The mark occupies ~75% of the badge, the usual proportion for a Marketplace icon.
const MARK_FILL = 0.75;

/** Grid point -> pixel for a `size`-square canvas, centering the mark's bounding box. */
function projector(size, centerMark) {
  const boxW = MARK_BOX.x1 - MARK_BOX.x0;
  const boxH = MARK_BOX.y1 - MARK_BOX.y0;
  const scale = (size * MARK_FILL) / Math.max(boxW, boxH);
  const mid = { x: (MARK_BOX.x0 + MARK_BOX.x1) / 2, y: (MARK_BOX.y0 + MARK_BOX.y1) / 2 };
  const origin = centerMark ? { x: size / 2, y: size / 2 } : { x: -mid.x * scale, y: -mid.y * scale };
  return ({ px, py }) => ({
    gx: (px + 0.5 - origin.x) / scale + mid.x,
    gy: (py + 0.5 - origin.y) / scale + mid.y,
    scale,
  });
}

const SS = 3; // supersamples per axis; the SDF already antialiases, this cleans up diagonals

function render(size, paint) {
  const rgba = Buffer.alloc(size * size * 4);
  const toGrid = projector(size, paint.centered);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let mark = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const { gx, gy, scale } = toGrid({ px: x + (sx + 0.5) / SS - 0.5, py: y + (sy + 0.5) / SS - 0.5 });
          mark += coverage(markDistance(gx, gy) * scale);
        }
      }
      mark /= SS * SS;

      const { r, g, b, a } = paint.pixel(x, y, mark, size);
      const i = (y * size + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }
  return rgba;
}

function renderBadge(size) {
  return render(size, {
    centered: true,
    pixel(x, y, mark) {
      const distance = roundedBoxDistance(x, y, size / 2, size / 2, size * BADGE_RADIUS_RATIO);
      const plate = coverage(distance);
      if (plate === 0) { return { r: 0, g: 0, b: 0, a: 0 }; }
      const t = Math.min(1, Math.max(0, (x / size + y / size) / 2));
      const mix = (i) => Math.round(BADGE_FROM[i] + (BADGE_TO[i] - BADGE_FROM[i]) * t);
      const white = 255 * mark;
      const mixWhite = (i) => Math.round(mix(i) * (1 - mark) + white);
      return { r: mixWhite(0), g: mixWhite(1), b: mixWhite(2), a: Math.round(plate * 255) };
    },
  });
}

function renderOnFlat(size, fg, bg) {
  return render(size, {
    centered: true,
    pixel(_x, _y, mark) {
      return {
        r: Math.round(bg[0] * (1 - mark) + fg[0] * mark),
        g: Math.round(bg[1] * (1 - mark) + fg[1] * mark),
        b: Math.round(bg[2] * (1 - mark) + fg[2] * mark),
        a: 255,
      };
    },
  });
}

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- SVG --------------------------------------------------------------------

function toSvg(color = 'currentColor') {
  const n = (v) => Number(v.toFixed(2));
  const at = (m, angle) => [n(m.cx + m.r * Math.cos(angle * Math.PI / 180)), n(m.cy + m.r * Math.sin(angle * Math.PI / 180))];
  // The bubble is a closed subpath; the prompt strokes after it start elsewhere, so each
  // segment opens its own subpath whenever it does not continue from the current point.
  const parts = [];
  let cursor = null;
  let subpathStart = null;
  for (const m of MARKS) {
    const from = m.kind === 'line' ? [m.ax, m.ay] : at(m, m.from);
    const to = m.kind === 'line' ? [m.bx, m.by] : at(m, m.to);
    if (!cursor || cursor[0] !== from[0] || cursor[1] !== from[1]) {
      parts.push(`M${from[0]} ${from[1]}`);
      subpathStart = from;
    }
    parts.push(m.kind === 'line' ? `L${to[0]} ${to[1]}` : `A${m.r} ${m.r} 0 0 1 ${to[0]} ${to[1]}`);
    if (to[0] === subpathStart[0] && to[1] === subpathStart[1]) parts.push('Z');
    cursor = to;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" fill="none"` +
    ` stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${parts.join('')}"/></svg>\n`;
}

// --- output -----------------------------------------------------------------

const BADGE_SIZE = 128;
mkdirSync(join(ROOT, 'resources'), { recursive: true });
writeFileSync(join(ROOT, 'resources', 'icon.svg'), toSvg());
writeFileSync(join(ROOT, 'resources', 'icon.png'), encodePng(BADGE_SIZE, BADGE_SIZE, renderBadge(BADGE_SIZE)));
// 编辑区标签栏那颗按钮：`icon` 走**文件路径**（不是 codicon），而 VS Code 把这种 SVG 当
// 图片渲染 —— `currentColor` 在那儿解析不出颜色，所以必须给出**写死颜色**的 light/dark 两份
// （light 主题配深色字形，dark 主题配浅色字形，取值与 VS Code 自己的工具栏图标一致）。
writeFileSync(join(ROOT, 'resources', 'icon-editor-light.svg'), toSvg('#424242'));
writeFileSync(join(ROOT, 'resources', 'icon-editor-dark.svg'), toSvg('#c5c5c5'));
console.log(`icon.svg + icon.png (${BADGE_SIZE}x${BADGE_SIZE}) + icon-editor-{light,dark}.svg written to resources/`);

if (process.argv.includes('--preview')) {
  const dir = join(tmpdir(), 'vac-icon-preview');
  mkdirSync(dir, { recursive: true });
  const sizes = [128, 64, 48, 32, 24, 16];
  for (const size of sizes) {
    writeFileSync(join(dir, `badge-${size}.png`), encodePng(size, size, renderBadge(size)));
    writeFileSync(join(dir, `dark-${size}.png`), encodePng(size, size, renderOnFlat(size, [0xcc, 0xcc, 0xcc], [0x1e, 0x1e, 0x1e])));
    writeFileSync(join(dir, `light-${size}.png`), encodePng(size, size, renderOnFlat(size, [0x42, 0x42, 0x42], [0xff, 0xff, 0xff])));
  }
  console.log(`previews (badge-*/dark-*/light-*): ${dir}`);
}
