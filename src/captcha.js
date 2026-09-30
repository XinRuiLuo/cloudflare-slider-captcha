/* ============================================================
 * cloudflare-slider-captcha · 服务端核心
 *
 * 自托管拼图（缺口滑块）人机验证，跑在 Cloudflare Pages Functions + D1 上。
 * 出题、校验、签发 ticket 全在本站完成，不向任何第三方发送数据。
 *
 * 对外接口（见 functions/api/captcha）：
 *   GET  /api/captcha/new     出题：返回一张带缺口的背景图 + 一块拼图
 *   POST /api/captcha/verify  校验落点与拖动轨迹，通过后签发一次性 ticket
 *
 * 业务接口要自己消费 ticket（消费一次即失效，无法重放）：
 *   if (!(await consumeTicket(data?.captchaToken, request, env))) {
 *     return json({ error: '请先完成人机验证' }, 400);
 *   }
 * ============================================================ */

import { captchaConfig as cfg } from './config.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_STORE = new Map();

/* ---------------- 基础工具 ---------------- */

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function sanitizeText(value, maxLength = 200) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function getClientIp(request) {
  const ip = request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')
    || request.headers.get('X-Real-IP')
    || 'unknown';
  return String(ip).split(',')[0].trim() || 'unknown';
}

function getCookie(request, name) {
  const source = request.headers.get('Cookie') || '';
  const item = source.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}

// 设备指纹只做记录/风控留痕，不参与本次判定；缺省即为空。
function getDeviceFingerprint(request) {
  const value = getCookie(request, 'captcha_device') || request.headers.get('X-Device-Fingerprint') || '';
  return /^[a-zA-Z0-9._:-]{8,128}$/.test(value) ? value : '';
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function id() {
  return crypto.randomUUID();
}

async function body(request) {
  try {
    return await request.json();
  } catch (error) {
    return null;
  }
}

// 进程内滑动窗口限流：单个 isolate 生效，兜底防止刷接口。
function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = RATE_LIMIT_STORE.get(key) || [];
  const valid = bucket.filter((timestamp) => now - timestamp < windowMs);
  if (valid.length >= limit) {
    RATE_LIMIT_STORE.set(key, valid);
    return false;
  }
  valid.push(now);
  RATE_LIMIT_STORE.set(key, valid);
  return true;
}

/**
 * 同源校验：GET 放行，其余跨站请求直接拒绝。
 * 命中返回一个 403 Response，通过返回 null。
 */
export function requireSameOrigin(request) {
  if (!cfg.enforceSameOrigin) return null;
  if (request.method === 'GET' || request.method === 'OPTIONS') return null;
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  try {
    const { host } = new URL(request.url);
    if (new URL(origin).host === host) return null;
  } catch (error) {
    // Origin 非法，按跨站处理
  }
  return json({ error: '跨站请求已拒绝' }, 403);
}

/* ---------------- 建表 ---------------- */

let schemaReady = false;

export async function ensureCaptchaSchema(env) {
  if (schemaReady) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS captcha_challenges (
      id TEXT PRIMARY KEY,
      answer INTEGER NOT NULL,
      piece_y INTEGER NOT NULL,
      piece_w INTEGER NOT NULL,
      piece_h INTEGER NOT NULL,
      pieces TEXT,
      ip TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      solved INTEGER NOT NULL DEFAULT 0 CHECK(solved IN (0, 1)),
      ticket TEXT,
      ticket_used INTEGER NOT NULL DEFAULT 0 CHECK(ticket_used IN (0, 1)),
      solved_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  const info = await env.DB.prepare('PRAGMA table_info(captcha_challenges)').all();
  if (!(info.results || []).some((column) => column.name === 'pieces')) {
    await env.DB.prepare('ALTER TABLE captcha_challenges ADD COLUMN pieces TEXT').run();
  }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_captcha_ticket ON captcha_challenges(ticket)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_captcha_expires ON captcha_challenges(expires_at)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_captcha_ip_created ON captcha_challenges(ip, created_at)').run();
  schemaReady = true;
}

/* ---------------- SVG 生成 ---------------- */

function mulberry32(seed) {
  let value = seed >>> 0;
  return function random() {
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function svgDataUri(svg) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// 拼图块轮廓：右下角带一个凸起半圆，位于 (0,0)-(size,size) 内
function captchaPiecePath(size) {
  const knob = size * 0.18;
  const half = size / 2;
  return `M0 0 H${size} V${half - knob} A${knob} ${knob} 0 0 1 ${size} ${half + knob} V${size} H0 Z`;
}

// 同一份 art 同时内联进背景与拼图，靠坐标平移保证像素级对齐
function captchaArt(seed, width, height) {
  const random = mulberry32(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const palette = ['#1c4a30', '#255a39', '#2f6b42', '#16412a', '#3b7d4c', '#0f3623', '#4c8f57'];
  const shapes = [];
  const count = 9 + Math.floor(random() * 6);
  for (let index = 0; index < count; index += 1) {
    const kind = random();
    const color = pick(palette);
    const opacity = (0.2 + random() * 0.5).toFixed(2);
    if (kind < 0.34) {
      shapes.push(`<circle cx="${(random() * width).toFixed(1)}" cy="${(random() * height).toFixed(1)}" r="${(8 + random() * 34).toFixed(1)}" fill="${color}" opacity="${opacity}"/>`);
    } else if (kind < 0.68) {
      const x = random() * width;
      const y = random() * height;
      const rectW = 26 + random() * 54;
      const rectH = 26 + random() * 54;
      const rotate = (random() * 90).toFixed(1);
      shapes.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${rectW.toFixed(1)}" height="${rectH.toFixed(1)}" rx="${(6 + random() * 10).toFixed(1)}" fill="${color}" opacity="${opacity}" transform="rotate(${rotate} ${(x + rectW / 2).toFixed(1)} ${(y + rectH / 2).toFixed(1)})"/>`);
    } else {
      const x = random() * width;
      const y = random() * height;
      const triW = 30 + random() * 46;
      const triH = 40 + random() * 60;
      shapes.push(`<polygon points="${x.toFixed(1)},${y.toFixed(1)} ${(x - triW / 2).toFixed(1)},${(y + triH).toFixed(1)} ${(x + triW / 2).toFixed(1)},${(y + triH).toFixed(1)}" fill="${color}" opacity="${opacity}"/>`);
    }
  }
  shapes.push(`<path d="M0 ${(height * 0.62).toFixed(0)} Q ${(width * 0.3).toFixed(0)} ${(height * 0.44).toFixed(0)} ${(width * 0.58).toFixed(0)} ${(height * 0.66).toFixed(0)} T ${width} ${(height * 0.55).toFixed(0)}" fill="none" stroke="#d8f0c4" stroke-opacity="0.22" stroke-width="10"/>`);
  return `<defs><linearGradient id="fcg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${pick(palette)}"/><stop offset="1" stop-color="${pick(palette)}"/></linearGradient></defs>`
    + `<rect width="${width}" height="${height}" fill="url(#fcg)"/>`
    + shapes.join('');
}

// 干扰基点：把答案坐标拆成「偏移 + 基点」两段，答案不再以单个 translate 明文出现
function captchaDecoy(padding) {
  return Math.round((Math.random() * 2 - 1) * padding);
}

/* ---------------- 出题 ---------------- */

export async function issueChallenge(request, env) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`captcha:${ip}`, cfg.requestLimitPerMinute, RATE_LIMIT_WINDOW_MS)) {
    return json({ error: '请求过于频繁，请稍后再试' }, 429);
  }
  await env.DB.prepare("DELETE FROM captcha_challenges WHERE expires_at <= datetime('now', '-1 hour')").run();

  // 全局出题配额：写进 D1，跨 isolate 生效，机器人无法无限领题去穷举
  const issued = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM captcha_challenges WHERE ip = ? AND created_at > datetime('now', '-1 minute')"
  ).bind(ip).first();
  if ((issued?.total || 0) >= cfg.issueLimitPerMinute) {
    return json({ error: '人机验证请求过于频繁，请稍后再试' }, 429);
  }

  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const random = mulberry32(seed ^ 0x9e3779b9);
  const size = cfg.pieceSize;
  const pieceW = Math.round(size * 1.18);
  const pieceH = size;
  // 一道题只拖一块拼图；背景上有 2~3 个缺口，大小不同，只有一个与拼图同尺寸
  const gapCount = cfg.minGaps + Math.floor(random() * (cfg.maxGaps - cfg.minGaps + 1));
  const correctIndex = Math.floor(random() * gapCount);
  const bandH = cfg.stageHeight / gapCount;
  const minX = Math.round(cfg.stageWidth * 0.32);
  // 干扰缺口要明显偏大或偏小，让用户一眼能按尺寸判断哪个对
  const slots = [];
  for (let index = 0; index < gapCount; index += 1) {
    const isCorrect = index === correctIndex;
    const scale = isCorrect ? 1 : (random() < 0.5 ? 0.66 + random() * 0.1 : 1.24 + random() * 0.18);
    const w = Math.round(pieceW * scale);
    const h = Math.round(pieceH * scale);
    const center = index * bandH + (bandH - h) / 2 + (random() * 6 - 3);
    const y = Math.round(Math.min(Math.max(center, 2), cfg.stageHeight - h - 2));
    const maxX = cfg.stageWidth - w - 6;
    const x = Math.round(minX + random() * (maxX - minX));
    slots.push({ x, y, w, h, scale, correct: isCorrect });
  }
  const target = slots[correctIndex];

  const art = captchaArt(seed, cfg.stageWidth, cfg.stageHeight);
  const decoy = captchaDecoy(900);
  // 每个缺口按自己的缩放画 path，外形一样、大小不同，答案坐标拆成「干扰基点 + 内层偏移」两段
  const marks = slots
    .map((slot) => {
      const slotPath = captchaPiecePath(Math.round(size * slot.scale));
      return `<path d="${slotPath}" transform="translate(${slot.x - decoy} ${slot.y - decoy})" fill="rgba(5,16,11,.66)" stroke="rgba(186,232,164,.72)" stroke-width="1.6"/>`;
    })
    .join('');
  const bg = svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cfg.stageWidth} ${cfg.stageHeight}" width="${cfg.stageWidth}" height="${cfg.stageHeight}">${art}<g transform="translate(${decoy} ${decoy})">${marks}</g></svg>`);
  // 只生成正确那一块的拼图，按 pieceW×pieceH 裁切
  const piecePath = captchaPiecePath(size);
  const shift = captchaDecoy(700);
  const pieceImage = svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pieceW} ${pieceH}" width="${pieceW}" height="${pieceH}">`
    + `<defs><clipPath id="fcp"><path d="${piecePath}"/></clipPath></defs>`
    + `<g clip-path="url(#fcp)"><g transform="translate(${shift} ${shift})"><g transform="translate(${-target.x - shift} ${-target.y - shift})">${art}</g></g></g>`
    + `</svg>`
  );

  const challengeId = id();
  // created_at 用带毫秒的 ISO 字符串，否则 SQLite CURRENT_TIMESTAMP 只到秒，墙钟校验会被精度截断绕过
  await env.DB.prepare(`
    INSERT INTO captcha_challenges (id, answer, piece_y, piece_w, piece_h, pieces, ip, device, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).bind(challengeId, target.x, target.y, pieceW, pieceH, JSON.stringify({ slots, correctIndex }), ip, getDeviceFingerprint(request), `+${cfg.ttlSeconds} seconds`).run();
  return json({
    id: challengeId,
    w: cfg.stageWidth,
    h: cfg.stageHeight,
    ttl: cfg.ttlSeconds,
    attempts: cfg.maxAttempts,
    bg,
    pieces: [{ index: 0, y: target.y, w: pieceW, h: pieceH, image: pieceImage }]
  });
}

/* ---------------- 轨迹 / 落点校验 ---------------- */

// 单块拼图的轨迹校验：时长、单调性、禁止瞬移、瞬时速度上限、抖动方差、回摆比例
// 阈值对手机触摸做了放宽：触摸滑动天然比鼠标平滑、点数更少、抖动更小
function captchaTrackLooksHuman(track, finalX, span) {
  if (!Array.isArray(track) || track.length < 4 || track.length > 400) return false;
  const points = track
    .map((item) => ({ x: Number(item?.x), t: Number(item?.t) }))
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.t));
  if (points.length < 4) return false;
  const duration = points[points.length - 1].t - points[0].t;
  if (duration < 140 || duration > 12000) return false;
  const stepLimit = Math.max(70, span * 0.6);
  let path = 0;
  let reversals = 0;
  for (let index = 1; index < points.length; index += 1) {
    const dt = points[index].t - points[index - 1].t;
    const dx = points[index].x - points[index - 1].x;
    if (dt < 0) return false;
    if (dx < -5) return false;
    if (dx > stepLimit) return false;
    if (dt > 0 && dx / dt > 5) return false;
    if (index > 1) {
      const previous = points[index - 1].x - points[index - 2].x;
      if (previous > 0 && dx < 0) reversals += 1;
    }
    path += Math.abs(dx);
  }
  if (reversals > Math.max(4, points.length * 0.4)) return false;
  if (path > span * 2 + 60) return false;
  if (path / Math.max(1, duration) > 2.2) return false;
  if (Math.abs(points[points.length - 1].x - finalX) > 7) return false;
  const deltas = [];
  for (let index = 1; index < points.length; index += 1) deltas.push(points[index].x - points[index - 1].x);
  // 完全匀速的脚本轨迹（所有 dx 相同）会被拒；真人触摸至少有微小变化
  if (new Set(deltas.map((delta) => Math.round(delta * 2) / 2)).size < 2) return false;
  const mean = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
  const variance = deltas.reduce((sum, delta) => sum + (delta - mean) ** 2, 0) / deltas.length;
  return variance >= 0.05;
}

// 单块拼图校验：落点是否在正确缺口、轨迹是否像人
function captchaPlacementsLookHuman(placements, target) {
  if (!Array.isArray(placements) || placements.length !== 1) return false;
  const placement = placements[0];
  const x = Number(placement?.x);
  if (!Number.isFinite(x)) return false;
  if (Math.abs(x - target.x) > cfg.tolerance) return false;
  return captchaTrackLooksHuman(placement?.track, x, Math.max(60, target.x));
}

/* ---------------- 校验并发 ticket ---------------- */

export async function verifyChallenge(request, env) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`captcha:${ip}`, cfg.requestLimitPerMinute, RATE_LIMIT_WINDOW_MS)) {
    return json({ error: '请求过于频繁，请稍后再试' }, 429);
  }
  const data = await body(request);
  const challengeId = sanitizeText(data?.id, 64);
  if (!challengeId) return json({ error: '人机验证参数缺失' }, 400);
  const row = await env.DB.prepare('SELECT * FROM captcha_challenges WHERE id = ?').bind(challengeId).first();
  if (!row) return json({ error: '人机验证已失效，请点击刷新重试' }, 400);
  if (row.solved) return json({ error: '本次验证已完成，请直接提交' }, 400);
  if (new Date(`${String(row.expires_at).replace(' ', 'T')}Z`).getTime() < Date.now()) {
    return json({ error: '人机验证已过期，请点击刷新重试' }, 400);
  }
  let stored = null;
  try { stored = row.pieces ? JSON.parse(row.pieces) : null; } catch (error) { stored = null; }
  const slots = stored && Array.isArray(stored.slots) ? stored.slots : null;
  const correctIndex = stored && Number.isInteger(stored.correctIndex) ? stored.correctIndex : -1;
  const target = slots && correctIndex >= 0 ? slots[correctIndex] : null;
  if (!target) return json({ error: '人机验证已更新，请刷新页面重试' }, 400);
  if (!Array.isArray(data?.placements)) return json({ error: '人机验证参数缺失，请点击刷新重试' }, 400);
  // 墙钟下限：单块拼图看题+判断+拖动也不可能在 minMsPerPiece 内完成
  const createdRaw = String(row.created_at || '');
  const createdMs = new Date(createdRaw.includes('T') ? createdRaw : `${createdRaw.replace(' ', 'T')}Z`).getTime();
  const elapsed = Date.now() - createdMs;
  const requiresHumanTime = Number.isFinite(createdMs) && elapsed >= cfg.minMsPerPiece;
  const failed = !requiresHumanTime || !captchaPlacementsLookHuman(data.placements, target);
  if (failed) {
    const remaining = cfg.maxAttempts - row.attempts - 1;
    if (remaining <= 0) {
      await env.DB.prepare('DELETE FROM captcha_challenges WHERE id = ?').bind(challengeId).run();
      return json({ error: '验证失败次数过多，请点击右上角刷新重试', remaining: 0, expired: true }, 400);
    }
    await env.DB.prepare('UPDATE captcha_challenges SET attempts = attempts + 1 WHERE id = ?').bind(challengeId).run();
    return json({ error: requiresHumanTime ? `还有拼图没对齐，还能再试 ${remaining} 次` : '操作过快，请放慢速度重新拖动', remaining }, 400);
  }
  const ticket = hex(crypto.getRandomValues(new Uint8Array(24)));
  await env.DB.prepare("UPDATE captcha_challenges SET solved = 1, ticket = ?, solved_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(ticket, challengeId).run();
  return json({ success: true, ticket, expiresIn: cfg.ttlSeconds });
}

/**
 * 业务侧消费 ticket：已解出、未被使用、未过期、同 IP 才算通过。
 * 通过后立即标记为已用，重复提交同一 ticket 会失败。
 * 返回 true / false。
 */
export async function consumeTicket(token, request, env) {
  if (!token || typeof token !== 'string' || token.length > 128) return false;
  const row = await env.DB.prepare(`
    SELECT id, ip FROM captcha_challenges
    WHERE ticket = ? AND solved = 1 AND ticket_used = 0 AND expires_at > datetime('now')
  `).bind(token).first();
  if (!row) return false;
  const clientIp = getClientIp(request);
  if (row.ip && row.ip !== 'unknown' && clientIp !== 'unknown' && row.ip !== clientIp) return false;
  await env.DB.prepare('UPDATE captcha_challenges SET ticket_used = 1 WHERE id = ?').bind(row.id).run();
  return true;
}