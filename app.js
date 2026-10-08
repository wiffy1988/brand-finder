'use strict';
/* 尾货寻牌 — 单页 PWA。无后端：照片直接从浏览器发给 Google Gemini API。 */

const APP_VERSION = '1.0.0';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_PHOTOS = 6;
const MAX_EDGE = 1280;      // 发给模型的图片最长边
const JPEG_QUALITY = 0.82;
const THUMB_EDGE = 240;
const REQUEST_TIMEOUT_MS = 150000;

const LS = {
  key: 'bf.apiKey',
  model: 'bf.model',
  search: 'bf.search',
  fallback: 'bf.fallback',
  fallbackModel: 'bf.fallbackModel',
  installDismissed: 'bf.installDismissed',
};
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_FALLBACK_MODEL = 'gemini-3.8-flash';
const PRESET_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const has = (v) => v !== undefined && v !== null && String(v).trim() !== '' && !/^(未查到|未知|不确定|n\/?a|null|无)$/i.test(String(v).trim());

/* ---------------- 设置 ---------------- */
const settings = {
  get key() { return localStorage.getItem(LS.key) || ''; },
  set key(v) { v ? localStorage.setItem(LS.key, v) : localStorage.removeItem(LS.key); },
  get model() { return localStorage.getItem(LS.model) || DEFAULT_MODEL; },
  set model(v) { localStorage.setItem(LS.model, v); },
  get search() { return localStorage.getItem(LS.search) !== '0'; },
  set search(v) { localStorage.setItem(LS.search, v ? '1' : '0'); },
  get fallback() { return localStorage.getItem(LS.fallback) !== '0'; },
  set fallback(v) { localStorage.setItem(LS.fallback, v ? '1' : '0'); },
  get fallbackModel() { return localStorage.getItem(LS.fallbackModel) || DEFAULT_FALLBACK_MODEL; },
  set fallbackModel(v) { localStorage.setItem(LS.fallbackModel, v); },
};

/* ---------------- IndexedDB 历史 ---------------- */
const DB_NAME = 'brand-finder';
const STORE = 'lookups';
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbTx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let out;
    Promise.resolve(fn(store)).then((v) => { out = v; });
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const db = {
  put: (rec) => dbTx('readwrite', (s) => reqP(s.put(rec))),
  get: (id) => dbTx('readonly', (s) => reqP(s.get(id))),
  del: (id) => dbTx('readwrite', (s) => reqP(s.delete(id))),
  clear: () => dbTx('readwrite', (s) => reqP(s.clear())),
  all: () => dbTx('readonly', (s) => reqP(s.getAll())).then((a) => a.sort((x, y) => y.createdAt - x.createdAt)),
  count: () => dbTx('readonly', (s) => reqP(s.count())),
};

/* ---------------- 图片压缩 ---------------- */
async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
function drawScaled(img, maxEdge) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(img, 0, 0, cw, ch);
  return c;
}
const canvasToBlob = (c, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('图片压缩失败'))), 'image/jpeg', q));
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}
async function processPhoto(file) {
  const img = await loadImage(file);
  const big = await canvasToBlob(drawScaled(img, MAX_EDGE), JPEG_QUALITY);
  const thumb = drawScaled(img, THUMB_EDGE).toDataURL('image/jpeg', 0.7);
  return { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()), blob: big, thumb };
}

/* ---------------- Gemini 提示词 ---------------- */
const SYSTEM_PROMPT = `你是户外服装和小众服装品牌的鉴别专家。用户在中国港口城市的外贸尾货市场淘衣服（样衣、尾货、外贸单），然后在小红书分享。他会发来【同一件衣服】的多张照片：logo、水洗标/成分标、吊牌、款号标签、细节等。这些品牌在中国大多比较冷门（例如 SOS Sportswear of Sweden）。

你的任务：
1. 仔细读出照片里所有文字和标识：品牌名、logo 图形、款号/型号（Style/Art./Model No.）、RN 或 CA 编号、面料成分、产地（Made in）、尺码、季节代码等，作为识别依据。
2. 如果本次可以使用 Google 搜索，就用它核实品牌信息并寻找这件衣服的同款或相似款在售页面。优先参考品牌官网、维基百科、权威媒体和正规零售商。
3. 用简体中文回答。

硬性规则：
- 绝对不要编造。查不到或不确定的字段填 "未查到"，并在 uncertainties 里说明原因。年份、创始人、故事等如果各来源说法不一致，要写明分歧。
- 区分“照片里直接看到的”和“推测的”，推测要标明。
- listings 只能放本次搜索中真实看到的商品页面，url 必须原样来自搜索结果；没有搜到就返回空数组 []。绝不能凭记忆或猜测拼凑网址。
- 价格写原币种金额，并换算成人民币（写明使用的大致汇率）。正价、折扣价、二手价分开说明。
- 如果本次不能联网搜索：listings 必须是 []；品牌信息只写你非常确定的；价格只给粗略区间并注明“未联网核实”。
- 有趣的故事要具体（人物、年份、事件），2–3 条，不要空泛的宣传语。

只输出一个 JSON 对象，放在 \`\`\`json 代码块中，不要输出其他任何文字。结构如下（所有值都是字符串或字符串数组）：
{
  "brand": "品牌名（原文）",
  "brand_zh": "常见中文名或简短中文说明，没有就写 未查到",
  "brand_confidence": "高 / 中 / 低",
  "brand_evidence": "根据照片里的哪些内容认出来的",
  "country": "品牌来源国家",
  "founded": "创立年份",
  "founder": "创始人",
  "owner_now": "现在的母公司/归属，没有就写 未查到",
  "history": "品牌历史，150–300 字",
  "stories": ["有趣的故事1", "有趣的故事2", "有趣的故事3"],
  "known_for": "品牌主打什么、定位（价位档次、风格、代表产品线）",
  "product_name": "这件衣服的款式名称，认不出就写 未查到",
  "product_model": "款号/型号，照片里看到的或搜索确认的",
  "product_category": "品类，比如 冲锋衣、抓绒、羽绒服、针织衫",
  "material": "面料成分（根据水洗标）",
  "made_in": "产地（根据标签）",
  "product_evidence": "怎么确认是这个款式的",
  "listings": [
    {"title": "商品页标题", "store": "店铺或网站名", "url": "搜索结果里的原样网址", "price": "价格数字", "currency": "币种，比如 EUR", "price_cny": "约合人民币", "match": "同款 / 相似款", "note": "颜色、是否打折等"}
  ],
  "price_retail_cny": "正价大约多少人民币（区间）",
  "price_secondhand_cny": "二手/折扣大约多少人民币，查不到写 未查到",
  "price_note": "价格说明，包含使用的汇率",
  "uncertainties": ["不确定的地方1"],
  "search_keywords": ["适合在淘宝/闲鱼/eBay 搜这件衣服的关键词，英文和中文各一两个"]
}`;

function buildUserText(n, note, searchOn) {
  let t = `这是同一件衣服的 ${n} 张照片，请识别品牌和单品。`;
  if (note && note.trim()) t += `\n用户补充说明：${note.trim()}`;
  t += searchOn
    ? '\n本次可以使用 Google 搜索，请先搜索核实再回答。'
    : '\n注意：本次【不能】联网搜索。listings 必须为 []，不确定的内容一律写 未查到，价格注明“未联网核实”。';
  return t;
}

function buildRequestBody(images, note, searchOn) {
  const parts = [{ text: buildUserText(images.length, note, searchOn) }];
  for (const b64 of images) parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
  };
  if (searchOn) body.tools = [{ googleSearch: {} }];
  return body;
}

class GeminiError extends Error {
  constructor(message, { status = 0, reason = '', code = '', fatal = false } = {}) {
    super(message);
    this.status = status; this.reason = reason; this.code = code; this.fatal = fatal;
  }
}

async function callGemini(model, body, apiKey, signal) {
  let resp;
  try {
    resp = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new GeminiError('连不上 Google 服务器。请确认手机网络能访问 Google（在国内需要开启 VPN）。', { fatal: true, code: 'NETWORK' });
  }
  let data = null;
  try { data = await resp.json(); } catch { /* ignore */ }
  if (!resp.ok) {
    const err = data && data.error ? data.error : {};
    const reason = (err.details || []).map((d) => d.reason).filter(Boolean).join(',');
    const msg = err.message || `HTTP ${resp.status}`;
    const keyBad = /API_KEY_INVALID|API_KEY_.*EXPIRED/i.test(reason) || /API key not valid|API key expired/i.test(msg);
    throw new GeminiError(msg, { status: resp.status, reason, code: err.status || '', fatal: keyBad });
  }
  return data;
}

function explainError(e) {
  if (e.code === 'NETWORK') return e.message;
  if (e.fatal) return 'API 密钥无效或已过期，请到设置里重新粘贴。';
  if (e.status === 429) return `请求太频繁或今天的免费额度用完了（429）。稍等一会儿再试。\n${e.message}`;
  if (e.status === 404) return `这个模型不可用（404），可能你的账号没有权限。\n${e.message}`;
  if (e.status === 403) return `没有权限（403）。\n${e.message}`;
  if (e.status >= 500) return `Google 服务器暂时出错（${e.status}），稍后再试。\n${e.message}`;
  return `${e.status ? `（${e.status}）` : ''}${e.message}`;
}

function extractResponse(data) {
  const cand = data && data.candidates && data.candidates[0];
  if (!cand) {
    const br = data && data.promptFeedback && data.promptFeedback.blockReason;
    throw new GeminiError(br ? `请求被拦截：${br}` : '模型没有返回结果');
  }
  const text = ((cand.content && cand.content.parts) || [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text).join('');
  if (!text.trim()) throw new GeminiError(`模型没有返回文字（finishReason: ${cand.finishReason || '未知'}）`);
  const gm = cand.groundingMetadata || {};
  const sources = (gm.groundingChunks || [])
    .map((c) => c.web).filter((w) => w && w.uri)
    .map((w) => ({ uri: w.uri, title: w.title || '' }));
  return {
    text,
    sources,
    queries: gm.webSearchQueries || [],
    searchWidget: (gm.searchEntryPoint && gm.searchEntryPoint.renderedContent) || '',
    finishReason: cand.finishReason || '',
    usage: data.usageMetadata || null,
    modelVersion: data.modelVersion || '',
  };
}

function parseJSONLoose(text) {
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { const v = tryParse(fence[1].trim()); if (v) return v; }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { const v = tryParse(text.slice(a, b + 1)); if (v) return v; }
  return null;
}

/* 识别流程：首选模型联网 → 备用模型联网 → 不联网（可在设置里关掉自动降级） */
function planAttempts() {
  const primary = settings.model;
  const plan = [];
  if (settings.search) {
    plan.push({ model: primary, search: true });
    if (settings.fallback) {
      const alt = primary === 'gemini-2.5-flash' ? 'gemini-2.5-flash-lite'
        : primary.startsWith('gemini-2.5') ? 'gemini-2.5-flash' : 'gemini-2.5-flash';
      if (alt !== primary) plan.push({ model: alt, search: true });
      plan.push({ model: settings.fallbackModel || DEFAULT_FALLBACK_MODEL, search: false });
    }
  } else {
    plan.push({ model: primary, search: false });
    if (settings.fallback && settings.fallbackModel && settings.fallbackModel !== primary) {
      plan.push({ model: settings.fallbackModel, search: false });
    }
  }
  return plan;
}

async function analyze(photos, note, signal, onStatus) {
  const apiKey = settings.key;
  if (!apiKey) throw new GeminiError('请先在设置里填写 Gemini API 密钥。', { fatal: true });
  const images = await Promise.all(photos.map((p) => blobToBase64(p.blob)));
  const attempts = [];
  let lastErr = null;
  for (const step of planAttempts()) {
    onStatus(step.search ? `正在用 ${step.model} 识别并联网搜索…` : `正在用 ${step.model} 识别（不联网）…`);
    try {
      const data = await callGemini(step.model, buildRequestBody(images, note, step.search), apiKey, signal);
      const out = extractResponse(data);
      attempts.push({ model: step.model, search: step.search, ok: true });
      return { ...out, model: step.model, searchUsed: step.search, attempts };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      attempts.push({ model: step.model, search: step.search, ok: false, error: explainError(e) });
      lastErr = e;
      if (e.fatal) break;
    }
  }
  const err = new GeminiError(lastErr ? explainError(lastErr) : '识别失败');
  err.attempts = attempts;
  throw err;
}

/* ---------------- 链接核实 ---------------- */
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const bareDomain = (s) => String(s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
function sameSite(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}
/* 只把搜索来源（groundingChunks）里真实出现过的网页当作链接。来源的 title 通常是域名。 */
function matchSources(listing, sources) {
  const want = [hostOf(listing.url), bareDomain(listing.store)].filter(Boolean);
  const hits = sources.filter((s) => {
    const d = bareDomain(s.title) || hostOf(s.uri);
    return want.some((w) => sameSite(w, d));
  });
  return hits;
}
const searchUrl = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  googleShop: (q) => `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}`,
  taobao: (q) => `https://s.taobao.com/search?q=${encodeURIComponent(q)}`,
  ebay: (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,
  xhs: (q) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}`,
};

/* ---------------- 渲染结果 ---------------- */
function confBadge(c) {
  const s = String(c || '');
  if (/高/.test(s)) return '<span class="badge ok">品牌把握：高</span>';
  if (/中/.test(s)) return '<span class="badge warn">品牌把握：中</span>';
  if (/低/.test(s)) return '<span class="badge bad">品牌把握：低</span>';
  return '';
}
function kvRow(label, v) { return has(v) ? `<dt>${esc(label)}</dt><dd>${esc(v)}</dd>` : `<dt>${esc(label)}</dt><dd class="hint" style="margin:0">未查到</dd>`; }
function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderResult(rec) {
  const r = rec.parsed;
  const out = rec.response;
  const sources = out.sources || [];
  const searchName = r ? [r.brand, r.product_name, r.product_model].filter(has).join(' ') : '';
  const strip = (rec.thumbs || []).map((t) => `<img src="${t}" alt="">`).join('');
  const modeBadge = out.searchUsed
    ? (sources.length ? `<span class="badge ok">已联网 · ${sources.length} 个来源</span>` : '<span class="badge warn">已开联网，但没有返回来源</span>')
    : '<span class="badge bad">未联网 · 仅供参考</span>';
  let html = '';

  if (!r) {
    html += `<div class="card"><div class="badges">${modeBadge}<span class="badge">${esc(out.model)}</span></div>
      <p class="hint">模型没有按格式返回，下面是原始回答：</p><pre class="raw">${esc(out.text)}</pre></div>`;
  } else {
    html += `<div class="card">
      <div class="result-head"><div style="flex:1">
        <p class="brand">${esc(has(r.brand) ? r.brand : '未能确定品牌')}</p>
        ${has(r.brand_zh) ? `<div class="sub">${esc(r.brand_zh)}</div>` : ''}
        <div class="badges">${confBadge(r.brand_confidence)}${modeBadge}<span class="badge">${esc(out.model)}</span></div>
      </div></div>
      ${strip ? `<div class="strip">${strip}</div>` : ''}
      ${has(r.brand_evidence) ? `<p class="hint">识别依据：${esc(r.brand_evidence)}</p>` : ''}
    </div>`;

    if (!out.searchUsed) {
      html += `<div class="banner warn">这次没有联网搜索，品牌信息来自模型自身知识，可能过时或有误；没有同款链接。可以在设置里点“测试连接”看看哪个模型能联网。</div>`;
    }

    html += `<div class="card"><h2>品牌档案</h2><dl class="kv">
      ${kvRow('国家', r.country)}${kvRow('创立', r.founded)}${kvRow('创始人', r.founder)}${kvRow('现归属', r.owner_now)}
    </dl>
    ${has(r.known_for) ? `<h3>主打 / 定位</h3><p class="prose">${esc(r.known_for)}</p>` : ''}
    ${has(r.history) ? `<h3>品牌历史</h3><p class="prose">${esc(r.history)}</p>` : ''}
    ${Array.isArray(r.stories) && r.stories.filter(has).length ? `<h3>有趣的故事</h3><ul class="clean">${r.stories.filter(has).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
    </div>`;

    html += `<div class="card"><h2>这件衣服</h2><dl class="kv">
      ${kvRow('款式', r.product_name)}${kvRow('型号', r.product_model)}${kvRow('品类', r.product_category)}${kvRow('成分', r.material)}${kvRow('产地', r.made_in)}
    </dl>${has(r.product_evidence) ? `<p class="hint">${esc(r.product_evidence)}</p>` : ''}</div>`;

    const listings = Array.isArray(r.listings) ? r.listings.filter((l) => l && (has(l.title) || has(l.store))) : [];
    html += `<div class="card"><h2>同款 / 相似款</h2>`;
    if (!listings.length) {
      html += `<p class="hint">${out.searchUsed ? '这次搜索没找到在售页面。' : '未联网，无法提供链接。'}可以用下面的快捷搜索自己找找。</p>`;
    } else {
      for (const l of listings) {
        const hits = out.searchUsed ? matchSources(l, sources) : [];
        const price = [has(l.price) ? `${l.currency || ''} ${l.price}`.trim() : '', has(l.price_cny) ? `≈ ¥${String(l.price_cny).replace(/^[¥￥\s]+/, '')}` : ''].filter(Boolean).join('　');
        const q = [l.title, l.store].filter(has).join(' ');
        html += `<div class="listing">
          <div class="t">${esc(l.title || l.store)}</div>
          <div class="meta">${esc([l.store, l.match, l.note].filter(has).join(' · '))}</div>
          ${price ? `<div class="p">${esc(price)}</div>` : ''}
          <div class="meta">${hits.length
            ? hits.slice(0, 2).map((h, i) => `<a href="${esc(h.uri)}" target="_blank" rel="noopener noreferrer">打开来源页${hits.length > 1 ? i + 1 : ''}（${esc(h.title || hostOf(h.uri))}）</a>`).join('　')
            : `未在本次搜索来源中核实 · <a href="${esc(searchUrl.google(q))}" target="_blank" rel="noopener noreferrer">Google 搜这个</a>`}</div>
        </div>`;
      }
    }
    html += `<h3>价格</h3><dl class="kv">${kvRow('正价', r.price_retail_cny)}${kvRow('二手/折扣', r.price_secondhand_cny)}</dl>
      ${has(r.price_note) ? `<p class="hint">${esc(r.price_note)}</p>` : ''}</div>`;

    if (Array.isArray(r.uncertainties) && r.uncertainties.filter(has).length) {
      html += `<div class="card"><h2>⚠️ 需要核对</h2><ul class="clean">${r.uncertainties.filter(has).map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
    }
  }

  const kws = (r && Array.isArray(r.search_keywords) ? r.search_keywords.filter(has) : []);
  const q0 = searchName || kws[0] || '';
  if (q0) {
    const qEn = kws.find((k) => /[a-z]/i.test(k)) || q0;
    const qZh = kws.find((k) => /[\u4e00-\u9fff]/.test(k)) || q0;
    html += `<div class="card"><h2>快捷搜索</h2><p class="hint">这些是搜索入口，不是商品链接。</p><div class="chips">
      <a href="${esc(searchUrl.googleShop(qEn))}" target="_blank" rel="noopener noreferrer">Google 购物</a>
      <a href="${esc(searchUrl.ebay(qEn))}" target="_blank" rel="noopener noreferrer">eBay</a>
      <a href="${esc(searchUrl.taobao(qZh))}" target="_blank" rel="noopener noreferrer">淘宝</a>
      <a href="${esc(searchUrl.xhs(qZh))}" target="_blank" rel="noopener noreferrer">小红书</a>
      <a href="${esc(searchUrl.google(q0 + ' brand history'))}" target="_blank" rel="noopener noreferrer">Google 品牌</a>
    </div>${kws.length ? `<p class="hint">关键词：${esc(kws.join(' / '))}</p>` : ''}</div>`;
  }

  if (sources.length || out.searchWidget) {
    html += `<div class="card sources"><h2>参考来源</h2>
      <p class="hint">来自 Google 搜索的原始页面（经 Google 跳转）。较早的记录里，跳转链接可能已经失效。</p>
      <ol class="clean">${sources.map((s) => `<li><a href="${esc(s.uri)}" target="_blank" rel="noopener noreferrer">${esc(s.title || hostOf(s.uri) || s.uri)}</a></li>`).join('')}</ol>
      ${out.searchWidget ? '<iframe class="search-widget" id="search-widget" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" title="Google 搜索建议"></iframe>' : ''}
    </div>`;
  }

  html += `<div class="actions">
    <button class="btn primary" id="btn-copy">复制全文</button>
    <button class="btn" id="btn-rerun">重新识别</button>
    <button class="btn danger" id="btn-delete">删除记录</button>
  </div>
  <details class="card"><summary>技术信息</summary>
    <p class="hint">时间：${esc(fmtDate(rec.createdAt))}　模型：${esc(out.modelVersion || out.model)}</p>
    ${out.queries && out.queries.length ? `<p class="hint">搜索词：${esc(out.queries.join(' | '))}</p>` : ''}
    ${(out.attempts || []).map((a) => `<p class="hint">${a.ok ? '✅' : '❌'} ${esc(a.model)}${a.search ? '（联网）' : '（不联网）'}${a.error ? '：' + esc(a.error) : ''}</p>`).join('')}
    <pre class="raw">${esc(out.text)}</pre>
  </details>`;

  const el = $('#result');
  el.innerHTML = html;
  const iframe = $('#search-widget');
  if (iframe) {
    iframe.srcdoc = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank"><style>body{margin:0}</style></head><body>${out.searchWidget}</body></html>`;
    iframe.onload = () => { try { iframe.style.height = (iframe.contentDocument.body.scrollHeight + 8) + 'px'; } catch { /* cross-origin */ } };
  }
  $('#btn-copy').onclick = () => copyText(resultToText(rec));
  $('#btn-delete').onclick = async () => {
    if (!confirm('删除这条记录？')) return;
    await db.del(rec.id);
    toast('已删除');
    show('history');
  };
  $('#btn-rerun').onclick = async () => {
    state.photos = (rec.photos || []).map((p, i) => ({ id: `${rec.id}-${i}`, blob: p, thumb: rec.thumbs[i] }));
    $('#note').value = rec.note || '';
    renderPhotos();
    show('home');
  };
}

function resultToText(rec) {
  const r = rec.parsed, out = rec.response;
  if (!r) return out.text;
  const L = [];
  const line = (k, v) => { if (has(v)) L.push(`${k}：${v}`); };
  L.push(`【${r.brand || '未知品牌'}】${has(r.brand_zh) ? ' ' + r.brand_zh : ''}`);
  line('国家', r.country); line('创立', r.founded); line('创始人', r.founder); line('现归属', r.owner_now);
  if (has(r.known_for)) L.push(`\n主打/定位：${r.known_for}`);
  if (has(r.history)) L.push(`\n品牌历史：\n${r.history}`);
  const st = (r.stories || []).filter(has);
  if (st.length) L.push('\n有趣的故事：\n' + st.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  L.push('\n这件衣服：');
  line('款式', r.product_name); line('型号', r.product_model); line('品类', r.product_category); line('成分', r.material); line('产地', r.made_in);
  const ls = (r.listings || []).filter((l) => l && has(l.title));
  if (ls.length) {
    L.push('\n同款/相似款：');
    for (const l of ls) {
      const hits = out.searchUsed ? matchSources(l, out.sources || []) : [];
      L.push(`- ${l.title}（${l.store || ''}）${has(l.price) ? ` ${l.currency || ''} ${l.price}` : ''}${has(l.price_cny) ? ` ≈ ¥${String(l.price_cny).replace(/^[¥￥\s]+/, '')}` : ''}${hits[0] ? `\n  ${hits[0].uri}` : ''}`);
    }
  }
  L.push('');
  line('正价', r.price_retail_cny); line('二手/折扣', r.price_secondhand_cny); line('价格说明', r.price_note);
  const un = (r.uncertainties || []).filter(has);
  if (un.length) L.push('\n需要核对：\n' + un.map((s) => `- ${s}`).join('\n'));
  if (!out.searchUsed) L.push('\n（本次未联网，信息仅供参考）');
  return L.join('\n');
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, t.length);
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast('已复制');
}

/* ---------------- 页面状态 ---------------- */
const state = { photos: [], view: 'home', abort: null, timer: null };

function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

const TITLES = { home: '尾货寻牌', result: '识别结果', history: '历史记录', settings: '设置' };
function show(view) {
  state.view = view;
  for (const v of ['home', 'result', 'history', 'settings']) $(`#view-${v}`).hidden = v !== view;
  $('#title').textContent = TITLES[view];
  $('#btn-back').hidden = view === 'home';
  if (view === 'home') refreshHome();
  if (view === 'history') renderHistory();
  if (view === 'settings') loadSettingsForm();
  window.scrollTo(0, 0);
}

function refreshHome() {
  $('#key-banner').hidden = !!settings.key;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  $('#install-tip').hidden = standalone || !isIOS || localStorage.getItem(LS.installDismissed) === '1';
  $('#btn-analyze').disabled = !state.photos.length || !!state.abort;
}

function renderPhotos() {
  const grid = $('#photo-grid');
  grid.innerHTML = state.photos.map((p) => `<div class="thumb"><img src="${p.thumb}" alt=""><button data-del="${esc(p.id)}" aria-label="删除">×</button></div>`).join('');
  refreshHome();
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
  if (!files.length) return;
  const room = MAX_PHOTOS - state.photos.length;
  if (room <= 0) { toast(`最多 ${MAX_PHOTOS} 张`); return; }
  if (files.length > room) toast(`最多 ${MAX_PHOTOS} 张，只加了前 ${room} 张`);
  for (const f of files.slice(0, room)) {
    try {
      state.photos.push(await processPhoto(f));
      renderPhotos();
    } catch (e) {
      console.warn(e);
      toast('有一张图片读取失败');
    }
  }
}

async function runAnalyze() {
  if (!settings.key) { show('settings'); toast('先填写 API 密钥'); return; }
  if (!state.photos.length) return;
  $('#home-error').hidden = true;
  const ctrl = new AbortController();
  state.abort = ctrl;
  const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  $('#loading').hidden = false;
  refreshHome();
  state.timer = setInterval(() => { $('#loading-timer').textContent = Math.round((Date.now() - started) / 1000); }, 500);
  try {
    const note = $('#note').value;
    const response = await analyze(state.photos, note, ctrl.signal, (s) => { $('#loading-text').textContent = s; });
    const rec = {
      id: `${Date.now()}`,
      createdAt: Date.now(),
      note,
      thumbs: state.photos.map((p) => p.thumb),
      photos: state.photos.map((p) => p.blob),
      response,
      parsed: parseJSONLoose(response.text),
    };
    rec.title = rec.parsed && has(rec.parsed.brand) ? rec.parsed.brand : '未识别';
    try { await db.put(rec); } catch (e) { console.warn('保存历史失败', e); }
    state.photos = [];
    $('#note').value = '';
    renderPhotos();
    renderResult(rec);
    show('result');
  } catch (e) {
    const el = $('#home-error');
    if (e.name === 'AbortError') {
      el.textContent = Date.now() - started >= REQUEST_TIMEOUT_MS - 500 ? '等太久了，已停止。请检查网络后重试。' : '已取消。';
    } else {
      const tries = (e.attempts || []).filter((a) => !a.ok).map((a) => `· ${a.model}${a.search ? '（联网）' : '（不联网）'}：${a.error}`).join('\n');
      el.textContent = `识别失败：${e.message}${tries && e.attempts.length > 1 ? `\n\n尝试过：\n${tries}` : ''}`;
    }
    el.hidden = false;
  } finally {
    clearTimeout(timeout);
    clearInterval(state.timer);
    state.abort = null;
    $('#loading').hidden = true;
    refreshHome();
  }
}

async function renderHistory() {
  const box = $('#history-list');
  let items = [];
  try { items = await db.all(); } catch (e) { box.innerHTML = `<div class="banner error">读取历史失败：${esc(e.message)}</div>`; return; }
  if (!items.length) { box.innerHTML = '<div class="empty">还没有记录。识别过的衣服会保存在这里。</div>'; return; }
  box.innerHTML = items.map((r) => {
    const p = r.parsed || {};
    const sub = [p.product_name, p.country].filter(has).join(' · ');
    return `<div class="h-item" data-id="${esc(r.id)}">
      <img src="${(r.thumbs && r.thumbs[0]) || ''}" alt="">
      <div style="flex:1;min-width:0">
        <div class="t">${esc(r.title || '未识别')}</div>
        ${sub ? `<div class="meta">${esc(sub)}</div>` : ''}
        <div class="meta">${esc(fmtDate(r.createdAt))}${r.response && !r.response.searchUsed ? ' · 未联网' : ''}</div>
      </div></div>`;
  }).join('');
}

/* ---------------- 设置页 ---------------- */
function loadSettingsForm() {
  $('#api-key').value = settings.key;
  $('#key-status').textContent = settings.key ? `已保存（…${settings.key.slice(-4)}）` : '未保存';
  const m = settings.model;
  const isPreset = PRESET_MODELS.includes(m);
  $('#model').value = isPreset ? m : 'custom';
  $('#model-custom').hidden = isPreset;
  $('#model-custom').value = isPreset ? '' : m;
  $('#opt-search').checked = settings.search;
  $('#opt-fallback').checked = settings.fallback;
  $('#fallback-model').value = settings.fallbackModel;
  db.count().then((n) => { $('#history-count').textContent = `共 ${n} 条记录，保存在这台手机上。`; }).catch(() => {});
  $('#app-version').textContent = APP_VERSION;
}

async function runTest() {
  const key = settings.key;
  const box = $('#test-result');
  if (!key) { box.innerHTML = '<p class="hint">先保存密钥。</p>'; return; }
  const models = Array.from(new Set([settings.model, 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.8-flash']));
  const tests = models.map((m) => ({ model: m, search: true }));
  tests.push({ model: settings.fallbackModel || DEFAULT_FALLBACK_MODEL, search: false });
  box.innerHTML = tests.map((t, i) => `<div class="test-row"><span>${esc(t.model)}${t.search ? '（联网）' : '（不联网）'}</span><span id="t-${i}">测试中…</span></div>`).join('');
  $('#btn-test').disabled = true;
  await Promise.all(tests.map(async (t, i) => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: t.search ? 'SOS Sportswear of Sweden 是哪一年创立的？请搜索后只回答年份。' : '只回答：OK' }] }],
    };
    if (t.search) body.tools = [{ googleSearch: {} }];
    const cell = $(`#t-${i}`);
    try {
      const data = await callGemini(t.model, body, key);
      const out = extractResponse(data);
      if (t.search) cell.textContent = out.sources.length ? `✅ 可联网（${out.sources.length} 个来源）` : '⚠️ 可用，但这次没搜索';
      else cell.textContent = '✅ 可用';
    } catch (e) {
      cell.textContent = `❌ ${e.fatal ? '密钥无效' : e.status ? e.status : ''} ${e.code === 'NETWORK' ? '连不上 Google' : ''}`.trim();
      cell.title = e.message;
      const row = cell.parentElement;
      const msg = document.createElement('div');
      msg.className = 'hint';
      msg.textContent = e.message.slice(0, 220);
      row.after(msg);
    }
  }));
  $('#btn-test').disabled = false;
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  $('#btn-history').onclick = () => show('history');
  $('#btn-settings').onclick = () => show('settings');
  $('#btn-back').onclick = () => show(state.view === 'result' ? 'history' : 'home');
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) show(go.dataset.go);
    const del = e.target.closest('[data-del]');
    if (del) {
      state.photos = state.photos.filter((p) => p.id !== del.dataset.del);
      renderPhotos();
    }
    const item = e.target.closest('.h-item');
    if (item) {
      db.get(item.dataset.id).then((rec) => { if (rec) { renderResult(rec); show('result'); } });
    }
  });
  $('#dismiss-install').onclick = () => { localStorage.setItem(LS.installDismissed, '1'); refreshHome(); };
  for (const id of ['#input-camera', '#input-album']) {
    $(id).addEventListener('change', async (e) => { await addFiles(e.target.files); e.target.value = ''; });
  }
  $('#btn-analyze').onclick = runAnalyze;
  $('#btn-cancel').onclick = () => state.abort && state.abort.abort();

  $('#btn-toggle-key').onclick = () => {
    const i = $('#api-key');
    i.type = i.type === 'password' ? 'text' : 'password';
    $('#btn-toggle-key').textContent = i.type === 'password' ? '显示' : '隐藏';
  };
  $('#btn-save-key').onclick = () => {
    const v = $('#api-key').value.trim();
    if (!v) { toast('密钥是空的'); return; }
    if (!/^[A-Za-z0-9_\-.]{20,}$/.test(v)) { toast('密钥格式看起来不对，请检查'); }
    settings.key = v;
    loadSettingsForm();
    toast('已保存');
  };
  $('#btn-clear-key').onclick = () => {
    if (!confirm('从这台手机上清除密钥？')) return;
    settings.key = '';
    loadSettingsForm();
    toast('已清除');
  };
  $('#model').onchange = () => { $('#model-custom').hidden = $('#model').value !== 'custom'; };
  $('#btn-save-model').onclick = () => {
    const sel = $('#model').value;
    const m = sel === 'custom' ? $('#model-custom').value.trim() : sel;
    if (!m) { toast('请填写模型名'); return; }
    settings.model = m;
    settings.search = $('#opt-search').checked;
    settings.fallback = $('#opt-fallback').checked;
    settings.fallbackModel = $('#fallback-model').value.trim() || DEFAULT_FALLBACK_MODEL;
    toast('已保存');
  };
  $('#btn-test').onclick = runTest;
  $('#btn-clear-history').onclick = async () => {
    if (!confirm('确定清空所有历史记录？不能恢复。')) return;
    await db.clear();
    loadSettingsForm();
    toast('已清空');
  };
}

bind();
show('home');
renderPhotos();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 注册失败', e));
  });
}
