/**
 * 企业内部信息发布系统 —— Cloudflare Worker 后端
 *
 * 模块：
 *   1. 内部公告        GET  /api/notices            列表（公开给已部署的前端）
 *                     GET  /api/notices/:id        详情
 *   2. 阅后即焚公告    POST /api/burn               用 token 换取内容，读取的同时从 KV 删除
 *                     POST /api/admin/burn         管理员生成一次性链接
 *   3. 卡密取文件      POST /api/card               校验卡密，返回文本 / 链接 / 一次性下载地址
 *                     GET  /api/dl/:token          一次性下载（需绑定 R2）
 *
 * 必需配置（wrangler secret / vars）：
 *   ADMIN_TOKEN       管理员密钥，务必随机 32 位以上
 *   KV                绑定一个 Workers KV 命名空间
 * 可选配置：
 *   FILES             R2 桶绑定（卡密分发文件时使用）
 *   ALLOWED_ORIGINS   允许的前端来源，逗号分隔；留空则允许所有来源
 *   PAGES_URL         前端站点地址，用于拼接阅后即焚链接
 *   RATE_LIMIT        是否启用卡密爆破限流，默认 "on"
 */

const enc = new TextEncoder();

const K = {
  notice: 'notice:',
  burn: 'burn:',
  card: 'card:',
  dl: 'dl:',
  rl: 'rl:',
  breach: 'breach:',
};

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extra,
    },
  });
}

/** 抛出一个带状态码的错误，由顶层统一转成 JSON */
function fail(status, code, message) {
  const e = new Error(message || code);
  e.status = status;
  e.code = code;
  throw e;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowList = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const h = {
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };

  if (!origin) return h;
  if (allowList.length === 0 || allowList.includes('*')) {
    h['access-control-allow-origin'] = '*';
  } else if (allowList.includes(origin)) {
    h['access-control-allow-origin'] = origin;
  }
  // 不在白名单时不回 ACAO，浏览器会自己拦下响应
  return h;
}

async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hexId(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混的 I O 0 1

/** 生成人眼友好的卡密，形如 WXK7-3M9P-QR4T-8HND */
function makeCardCode(groups = 4, len = 4) {
  const out = [];
  for (let g = 0; g < groups; g += 1) {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let s = '';
    for (let i = 0; i < len; i += 1) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    out.push(s);
  }
  return out.join('-');
}

function normalizeCode(code) {
  return String(code || '').replace(/[\s\-_]/g, '').toUpperCase();
}

async function readJson(request, maxBytes = 512 * 1024) {
  const text = await request.text();
  if (text.length > maxBytes) fail(413, 'PAYLOAD_TOO_LARGE', '提交内容过大');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    fail(400, 'BAD_JSON', '请求体不是合法 JSON');
  }
}

function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) fail(500, 'NO_ADMIN_TOKEN', '服务端未配置 ADMIN_TOKEN');
  const auth = request.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token || !safeEqual(token, env.ADMIN_TOKEN)) fail(401, 'UNAUTHORIZED', '管理员密钥无效');
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function siteBase(request, env) {
  const base = String(env.PAGES_URL || '').trim().replace(/\/+$/, '');
  if (base) return base;
  const origin = request.headers.get('Origin');
  return origin ? origin.replace(/\/+$/, '') : '';
}

/* ------------------------------------------------------------------ *
 * 简易限流（存 KV，只在失败时计数，节省写入额度）
 * 免费版 KV 每天 1000 次写入，这套设计只把异常请求计入
 * ------------------------------------------------------------------ */

const RATE = {
  card: { max: 12, ttl: 3600 },   // 每 IP 每小时最多 12 次失败
  burn: { max: 30, ttl: 3600 },
  report: { max: 20, ttl: 3600 },
};

async function overLimit(env, bucket, id) {
  const conf = RATE[bucket];
  if (!conf) return false;
  const v = await env.KV.get(`${K.rl}${bucket}:${id}`, 'json');
  if (!v || v.reset < Date.now()) return false;
  return v.count >= conf.max;
}

async function bumpLimit(env, bucket, id) {
  const conf = RATE[bucket];
  if (!conf) return;
  const key = `${K.rl}${bucket}:${id}`;
  const v = await env.KV.get(key, 'json');
  const now = Date.now();
  const count = v && v.reset >= now ? v.count + 1 : 1;
  await env.KV.put(key, JSON.stringify({ count, reset: now + conf.ttl * 1000 }), {
    expirationTtl: conf.ttl,
  });
}

/* ------------------------------------------------------------------ *
 * 公告
 * ------------------------------------------------------------------ */

async function listNotices(env, limit = 200) {
  const names = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix: K.notice, cursor, limit: 1000 });
    for (const k of page.keys) names.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && names.length < limit);

  const items = await Promise.all(
    names.slice(0, limit).map((name) => env.KV.get(name, 'json'))
  );
  return items
    .filter(Boolean)
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
}

async function createNotice(env, input) {
  const title = String(input.title || '').trim();
  const body = String(input.body || '');
  if (!title) fail(400, 'BAD_REQUEST', '缺少公告标题');
  if (title.length > 120) fail(400, 'BAD_REQUEST', '标题超过 120 字');
  if (body.length > 30000) fail(400, 'BAD_REQUEST', '正文超过 30000 字');

  const notice = {
    id: 'n_' + hexId(6),
    title,
    body,
    tag: String(input.tag || '').trim().slice(0, 16),
    pinned: !!input.pinned,
    author: String(input.author || '').trim().slice(0, 40),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await env.KV.put(K.notice + notice.id, JSON.stringify(notice));
  return notice;
}

/* ------------------------------------------------------------------ *
 * 阅后即焚
 * ------------------------------------------------------------------ */

async function createBurn(env, request, input) {
  const body = String(input.body || '');
  const title = String(input.title || '紧急通知').trim() || '紧急通知';
  if (!body) fail(400, 'BAD_REQUEST', '缺少正内容');
  if (body.length > 30000) fail(400, 'BAD_REQUEST', '正文超过 30000 字');

  const hours = Number(input.ttlHours) > 0 ? Math.min(Number(input.ttlHours), 720) : 24;
  const token = hexId(20); // 160 bit，不可猜
  const item = {
    token,
    title,
    body,
    level: String(input.level || '内部机密').slice(0, 20),
    createdAt: new Date().toISOString(),
    expireAt: new Date(Date.now() + hours * 3600 * 1000).toISOString(),
  };
  await env.KV.put(K.burn + token, JSON.stringify(item), { expirationTtl: hours * 3600 });

  const base = siteBase(request, env);
  return { token, expireAt: item.expireAt, link: `${base}/burn.html#t=${token}` };
}

async function consumeBurn(env, request) {
  const ip = clientIp(request);
  if (String(env.RATE_LIMIT || 'on') === 'on' && (await overLimit(env, 'burn', ip))) {
    fail(429, 'TOO_MANY_REQUESTS', '访问过于频繁，请稍后再试');
  }
  const { token } = await readJson(request);
  const key = String(token || '').trim();
  if (!key || !/^[a-f0-9]{16,64}$/i.test(key)) fail(400, 'BAD_TOKEN', '链接参数无效');

  const item = await env.KV.get(K.burn + key, 'json');
  if (!item) {
    await bumpLimit(env, 'burn', ip);
    fail(404, 'BURN_GONE', '该内容不存在或已被销毁');
  }
  // 先删除再返回：即使返回途中失败，内容也已经不可再读
  await env.KV.delete(K.burn + key);

  return json({
    ok: true,
    data: {
      title: item.title,
      body: item.body,
      level: item.level,
      createdAt: item.createdAt,
    },
  });
}

/* ------------------------------------------------------------------ *
 * 卡密
 * ------------------------------------------------------------------ */

async function createCard(env, input) {
  const kind = String(input.kind || 'text');
  if (!['text', 'url', 'file'].includes(kind)) fail(400, 'BAD_REQUEST', 'kind 只能是 text / url / file');

  const content = String(input.content || '');
  const url = String(input.url || '').trim();
  const assetKey = String(input.assetKey || '').trim();

  if (kind === 'text' && !content) fail(400, 'BAD_REQUEST', '缺少卡密对应的文本内容');
  if (kind === 'url' && !/^https?:\/\//i.test(url)) fail(400, 'BAD_REQUEST', '文件链接必须以 http(s):// 开头');
  if (kind === 'file') {
    if (!env.FILES) fail(400, 'NO_BUCKET', '未绑定 R2 存储桶（FILES），无法使用 file 类型');
    if (!assetKey) fail(400, 'BAD_REQUEST', '缺少 R2 对象键 assetKey');
  }

  const maxUses = Math.max(1, Math.min(Number(input.maxUses) || 1, 999));
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) fail(400, 'BAD_REQUEST', '过期时间格式错误');
  if (expiresAt && expiresAt.getTime() < Date.now()) fail(400, 'BAD_REQUEST', '过期时间早于当前时间');

  const code = makeCardCode();
  const hash = await sha256(normalizeCode(code));

  const card = {
    hash,
    name: String(input.name || '').trim().slice(0, 60),
    note: String(input.note || '').trim().slice(0, 200),
    kind,
    content,
    url,
    assetKey,
    filename: String(input.filename || '').trim().slice(0, 120),
    maxUses,
    uses: 0,
    revoked: false,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };

  const opts = {};
  if (card.expiresAt) {
    opts.expirationTtl = Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000) + 3600);
  }
  await env.KV.put(K.card + hash, JSON.stringify(card), opts);

  return { code, expiresAt: card.expiresAt, maxUses, kind };
}

async function verifyCard(env, request, input) {
  const ip = clientIp(request);
  if (String(env.RATE_LIMIT || 'on') === 'on' && (await overLimit(env, 'card', ip))) {
    fail(429, 'TOO_MANY_REQUESTS', '验证过于频繁，请 1 小时后再试');
  }

  const code = normalizeCode(input.card);
  if (!code) fail(400, 'BAD_REQUEST', '请输入卡密');
  if (code.length < 8 || code.length > 64) fail(400, 'BAD_REQUEST', '卡密长度不正确');

  const hash = await sha256(code);
  const card = await env.KV.get(K.card + hash, 'json');

  if (!card) {
    await bumpLimit(env, 'card', ip);
    fail(404, 'CARD_INVALID', '卡密不存在，请核对后重新输入');
  }
  if (card.revoked) fail(403, 'CARD_REVOKED', '该卡密已被停用');
  if (card.expiresAt && new Date(card.expiresAt).getTime() < Date.now()) {
    await env.KV.delete(K.card + hash);
    fail(410, 'CARD_EXPIRED', '该卡密已过期');
  }
  if (card.uses >= card.maxUses) fail(410, 'CARD_EXHAUSTED', '该卡密可用次数已耗尽');

  const next = { ...card, uses: card.uses + 1, lastUsedAt: new Date().toISOString() };
  const opts = {};
  if (card.expiresAt) {
    opts.expirationTtl = Math.max(60, Math.floor((new Date(card.expiresAt).getTime() - Date.now()) / 1000) + 3600);
  }
  await env.KV.put(K.card + hash, JSON.stringify(next), opts);

  const left = card.maxUses - next.uses;
  const payload = {
    ok: true,
    name: card.name,
    note: card.note,
    kind: card.kind,
    remainingUses: left,
    expiresAt: card.expiresAt,
  };

  if (card.kind === 'text') {
    payload.content = card.content;
  } else if (card.kind === 'url') {
    payload.url = card.url;
    payload.filename = card.filename;
  } else {
    const dl = hexId(20);
    await env.KV.put(
      K.dl + dl,
      JSON.stringify({ key: card.assetKey, filename: card.filename || 'document', cardHash: hash }),
      { expirationTtl: 600 }
    );
    payload.download = `/api/dl/${dl}`;
    payload.filename = card.filename;
  }
  return json(payload);
}

async function serveDownload(env, token) {
  if (!/^[a-f0-9]{16,64}$/i.test(String(token || ''))) fail(400, 'BAD_TOKEN', '下载参数无效');
  if (!env.FILES) fail(500, 'NO_BUCKET', '未绑定 R2 存储桶');
  const key = K.dl + token;
  const meta = await env.KV.get(key, 'json');
  if (!meta) fail(404, 'DL_GONE', '下载链接已失效或已使用');
  await env.KV.delete(key); // 一次性

  const obj = await env.FILES.get(meta.key);
  if (!obj) fail(404, 'FILE_NOT_FOUND', '文件不存在');

  const filename = meta.filename || 'download';
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'no-store');
  headers.set(
    'content-disposition',
    `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  return new Response(obj.body, { headers });
}

async function listCards(env) {
  const names = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix: K.card, cursor, limit: 1000 });
    for (const k of page.keys) names.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const items = await Promise.all(names.map((n) => env.KV.get(n, 'json')));
  return items
    .filter(Boolean)
    .map((c) => ({
      hash: c.hash.slice(0, 10),
      name: c.name,
      note: c.note,
      kind: c.kind,
      uses: c.uses,
      maxUses: c.maxUses,
      revoked: c.revoked,
      createdAt: c.createdAt,
      expiresAt: c.expiresAt,
      lastUsedAt: c.lastUsedAt || null,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/* ------------------------------------------------------------------ *
 * 异常行为上报（防截屏触发时由前端调用，留痕审计）
 * ------------------------------------------------------------------ */

async function reportBreach(env, request) {
  const ip = clientIp(request);
  if (String(env.RATE_LIMIT || 'on') === 'on' && (await overLimit(env, 'report', ip))) {
    return json({ ok: false, error: 'RATE_LIMITED' }, 429);
  }
  const input = await readJson(request);
  const reason = String(input.reason || '').slice(0, 120);
  const token = String(input.token || '').slice(0, 64);
  const record = {
    at: new Date().toISOString(),
    ip,
    reason,
    token: token ? token.slice(0, 8) + '…' : '',
    ua: (request.headers.get('user-agent') || '').slice(0, 180),
    country: request.cf ? request.cf.country : '',
    city: request.cf ? request.cf.city : '',
  };
  await env.KV.put(K.breach + hexId(8), JSON.stringify(record), { expirationTtl: 90 * 24 * 3600 });
  await bumpLimit(env, 'report', ip);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

async function route(request, env, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (p === '/api/health') {
    return json({ ok: true, service: 'notice-portal', time: new Date().toISOString() });
  }

  // ---- 公告 ----
  if (p === '/api/notices' && method === 'GET') {
    const items = await listNotices(env);
    return json({ ok: true, count: items.length, data: items });
  }

  const mNotice = p.match(/^\/api\/notices\/([A-Za-z0-9_-]{3,40})$/);
  if (mNotice && method === 'GET') {
    const item = await env.KV.get(K.notice + mNotice[1], 'json');
    if (!item) fail(404, 'NOTICE_NOT_FOUND', '公告不存在或已删除');
    return json({ ok: true, data: item });
  }

  // ---- 阅后即焚 ----
  if (p === '/api/burn' && method === 'POST') {
    return consumeBurn(env, request);
  }

  // ---- 卡密 ----
  if (p === '/api/card' && method === 'POST') {
    const input = await readJson(request);
    return verifyCard(env, request, input);
  }

  const mDl = p.match(/^\/api\/dl\/([a-f0-9]{16,64})$/i);
  if (mDl && method === 'GET') {
    return serveDownload(env, mDl[1]);
  }

  if (p === '/api/report' && method === 'POST') {
    return reportBreach(env, request);
  }

  /* ---------------- 管理接口 ---------------- */

  if (p.startsWith('/api/admin/')) requireAdmin(request, env);

  if (p === '/api/admin/notices' && method === 'POST') {
    const notice = await createNotice(env, await readJson(request));
    return json({ ok: true, data: notice }, 201);
  }

  const mAdminNotice = p.match(/^\/api\/admin\/notices\/([A-Za-z0-9_-]{3,40})$/);
  if (mAdminNotice) {
    const key = K.notice + mAdminNotice[1];
    const current = await env.KV.get(key, 'json');
    if (!current) fail(404, 'NOTICE_NOT_FOUND', '公告不存在');

    if (method === 'PUT') {
      const input = await readJson(request);
      const next = {
        ...current,
        title: String(input.title ?? current.title).trim().slice(0, 120) || current.title,
        body: String(input.body ?? current.body).slice(0, 30000),
        tag: String(input.tag ?? current.tag).trim().slice(0, 16),
        pinned: input.pinned === undefined ? current.pinned : !!input.pinned,
        updatedAt: new Date().toISOString(),
      };
      await env.KV.put(key, JSON.stringify(next));
      return json({ ok: true, data: next });
    }
    if (method === 'DELETE') {
      await env.KV.delete(key);
      return json({ ok: true, deleted: mAdminNotice[1] });
    }
  }

  if (p === '/api/admin/burn' && method === 'POST') {
    const result = await createBurn(env, request, await readJson(request));
    return json({ ok: true, data: result }, 201);
  }

  if (p === '/api/admin/cards' && method === 'GET') {
    const data = await listCards(env);
    return json({ ok: true, count: data.length, data });
  }

  if (p === '/api/admin/cards' && method === 'POST') {
    const result = await createCard(env, await readJson(request));
    return json({ ok: true, data: result }, 201);
  }

  const mAdminCard = p.match(/^\/api\/admin\/cards\/([A-Za-z0-9-]{6,64})$/);
  if (mAdminCard && method === 'DELETE') {
    const hash = await sha256(normalizeCode(mAdminCard[1]));
    const key = K.card + hash;
    const card = await env.KV.get(key, 'json');
    if (!card) fail(404, 'CARD_INVALID', '卡密不存在');
    if (card.revoked) return json({ ok: true, data: { alreadyRevoked: true } });
    const next = { ...card, revoked: true, revokedAt: new Date().toISOString() };
    const opts = {};
    if (card.expiresAt) {
      opts.expirationTtl = Math.max(60, Math.floor((new Date(card.expiresAt).getTime() - Date.now()) / 1000) + 3600);
    }
    await env.KV.put(key, JSON.stringify(next), opts);
    return json({ ok: true, data: { revoked: true } });
  }

  // ---- 管理端按 hash 前缀停用（列表里只显示 hash 前缀）----
  if (p === '/api/admin/cards/revoke-by-hash' && method === 'POST') {
    const input = await readJson(request);
    const prefix = String(input.hashPrefix || '').trim();
    if (!/^[a-f0-9]{6,16}$/i.test(prefix)) fail(400, 'BAD_REQUEST', 'hash 前缀不合法');
    const names = [];
    const page = await env.KV.list({ prefix: K.card, limit: 1000 });
    for (const k of page.keys) {
      if (k.name.slice(K.card.length).startsWith(prefix)) names.push(k.name);
    }
    if (!names.length) fail(404, 'CARD_INVALID', '未找到对应卡密');
    for (const name of names) {
      const card = await env.KV.get(name, 'json');
      if (!card || card.revoked) continue;
      await env.KV.put(name, JSON.stringify({ ...card, revoked: true, revokedAt: new Date().toISOString() }));
    }
    return json({ ok: true, revoked: names.length });
  }

  fail(404, 'NOT_FOUND', '接口不存在');
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (!env.KV) fail(500, 'NO_KV', '未绑定 KV 命名空间');
      const res = await route(request, env, new URL(request.url));
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      if (status >= 500) console.error('worker error', err && (err.stack || err));
      const res = json(
        { ok: false, error: (err && err.code) || 'SERVER_ERROR', message: (err && err.message) || '服务异常' },
        status
      );
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status, headers });
    }
  },
};
