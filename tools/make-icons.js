// アイコンの PNG を作る。 npm run icons
const path = require('path');
const sharp = require('sharp');

const cx = 256, cy = 256, r = 158;
const P = deg => { const t = deg * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
const [sx, sy] = P(-55), [ex, ey] = P(235);
const t = 235 * Math.PI / 180;
const dir = [-Math.sin(t), Math.cos(t)], nor = [Math.cos(t), Math.sin(t)];
const tip = [ex + 58 * dir[0], ey + 58 * dir[1]];
const b1 = [ex + 46 * nor[0] - 6 * dir[0], ey + 46 * nor[1] - 6 * dir[1]];
const b2 = [ex - 46 * nor[0] - 6 * dir[0], ey - 46 * nor[1] - 6 * dir[1]];
const f = a => a.map(n => n.toFixed(1)).join(',');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#1f5f8b"/>
  <path d="M${f([sx, sy])} A${r},${r} 0 1 1 ${f([ex, ey])}" fill="none" stroke="#fff" stroke-width="40" stroke-linecap="round"/>
  <polygon points="${f(tip)} ${f(b1)} ${f(b2)}" fill="#fff"/>
  <path d="M256 352 C 226 312 198 284 198 244 A58 58 0 1 1 314 244 C 314 284 286 312 256 352 Z" fill="#fff"/>
  <circle cx="256" cy="244" r="22" fill="#1f5f8b"/>
</svg>`;

const out = path.join(__dirname, '..', 'icons');
(async () => {
  const buf = Buffer.from(svg);
  await sharp(buf).resize(512, 512).png().toFile(path.join(out, 'icon-512.png'));
  await sharp(buf).resize(192, 192).png().toFile(path.join(out, 'icon-192.png'));
  await sharp(buf).resize(180, 180).flatten({ background: '#1f5f8b' }).png().toFile(path.join(out, 'apple-touch-icon.png'));
  console.log('ok');
})();
