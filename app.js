/* 衣脉 · 品牌知识库 — Supabase 云端同步 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { SUPABASE_URL, SUPABASE_ANON_KEY, STORAGE_BUCKET } from './config.js';

const APP_VERSION = '3.0.2';
const MAX_FIND_PHOTOS = 12;
const IMG_MAX_EDGE = 1600;
const IMG_QUALITY = 0.85;
const LOCAL_CACHE_KEY = 'yimai-list-cache-v1';
const BRAND_COLUMNS = 'id,name,country,founded_year,founder,positioning,story,interesting,price_notes,tags,cover_path,created_at,updated_at';
const FIND_COLUMNS = 'id,brand_id,notes,found_at,created_at,updated_at';
const PHOTO_COLUMNS = 'id,find_id,storage_path,sort_order';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- Helpers ----------
function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    ('id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseTags(str) {
  if (!str) return [];
  return String(str).split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean);
}

function tagsToStr(tags) {
  return (tags || []).join(' ');
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function publicUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return data && data.publicUrl ? data.publicUrl : null;
}

function netErr(err) {
  const msg = (err && (err.message || err.error_description || err.error)) || String(err || '网络错误');
  if (/Failed to fetch|NetworkError|fetch/i.test(msg)) {
    return '网络连接失败，请检查网络或稍后再试';
  }
  if (/Could not find the table|relation .* does not exist|PGRST205|404/i.test(msg)) {
    return '云端表还没建好：请先在 Supabase SQL Editor 运行 supabase-schema.sql';
  }
  if (/Bucket not found|not found/i.test(msg) && /storage|bucket|finds/i.test(msg)) {
    return '存储桶 finds 不存在：请在 Storage 新建公开桶 finds，或再跑一遍 schema SQL';
  }
  return msg;
}

function showNetBanner(msg) {
  const el = document.getElementById('net-banner');
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

function mapBrand(row) {
  return {
    id: row.id,
    name: row.name,
    country: row.country || '',
    foundedYear: row.founded_year || '',
    founderOwner: row.founder || '',
    positioning: row.positioning || '',
    story: row.story || '',
    notes: row.interesting || '',
    priceRef: row.price_notes || '',
    tags: row.tags || [],
    coverPath: row.cover_path || null,
    isSample: Array.isArray(row.tags) && row.tags.includes('示例'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFind(row) {
  const photos = (row.find_photos || [])
    .slice()
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  return {
    id: row.id,
    brandId: row.brand_id || null,
    notes: row.notes || '',
    date: row.found_at || '',
    photos: photos.map((p) => ({
      id: p.id,
      path: p.storage_path,
      sortOrder: p.sort_order || 0,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const max = IMG_MAX_EDGE;
      if (width > max || height > max) {
        if (width >= height) {
          height = Math.round(height * (max / width));
          width = max;
        } else {
          width = Math.round(width * (max / height));
          height = max;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('压缩失败'))),
        'image/jpeg',
        IMG_QUALITY
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

async function uploadImage(blob, path) {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
  if (error) throw error;
  return path;
}

async function removeStoragePaths(paths) {
  const clean = (paths || []).filter(Boolean);
  if (!clean.length) return;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(clean);
  if (error) console.warn('storage remove', error);
}

// ---------- Data layer ----------
let brandsCache = [];
let findsCache = [];
let cacheReady = false;
let loadGen = 0;

function cacheSignature() {
  return JSON.stringify({ brands: brandsCache, finds: findsCache });
}

function persistLocalCache() {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      brands: brandsCache,
      finds: findsCache,
    }));
  } catch (err) {
    console.warn('local cache', err);
  }
}

function hydrateLocalCache() {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || data.v !== 1 || !Array.isArray(data.brands) || !Array.isArray(data.finds)) return false;
    brandsCache = data.brands.filter((b) => b && b.id);
    findsCache = data.finds.filter((f) => f && f.id).map((f) => ({
      ...f,
      photos: Array.isArray(f.photos) ? f.photos : [],
    }));
    return true;
  } catch {
    return false;
  }
}

function sortFinds() {
  findsCache.sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') ||
    String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  );
}

async function loadAll() {
  const gen = ++loadGen;
  const [brandsRes, findsRes, photosRes] = await Promise.all([
    supabase.from('brands').select(BRAND_COLUMNS).order('updated_at', { ascending: false }),
    supabase.from('finds').select(FIND_COLUMNS).order('found_at', { ascending: false }),
    supabase.from('find_photos').select(PHOTO_COLUMNS).order('sort_order', { ascending: true }),
  ]);
  if (brandsRes.error) throw brandsRes.error;
  if (findsRes.error) throw findsRes.error;
  if (photosRes.error) throw photosRes.error;
  if (gen !== loadGen) return { brands: brandsCache, finds: findsCache };

  const photosByFind = new Map();
  for (const p of photosRes.data || []) {
    const list = photosByFind.get(p.find_id);
    if (list) list.push(p);
    else photosByFind.set(p.find_id, [p]);
  }
  brandsCache = (brandsRes.data || []).map(mapBrand);
  findsCache = (findsRes.data || []).map((row) =>
    mapFind({ ...row, find_photos: photosByFind.get(row.id) || [] })
  );
  sortFinds();
  cacheReady = true;
  showNetBanner(null);
  persistLocalCache();
  return { brands: brandsCache, finds: findsCache };
}

async function refreshCaches() {
  try {
    await loadAll();
  } catch (err) {
    console.error(err);
    showNetBanner(netErr(err));
    throw err;
  }
}

async function getBrand(id) {
  const hit = brandsCache.find((b) => b.id === id);
  if (hit) return hit;
  const { data, error } = await supabase.from('brands').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? mapBrand(data) : null;
}

async function getFind(id) {
  const hit = findsCache.find((f) => f.id === id);
  if (hit) return hit;
  const { data, error } = await supabase
    .from('finds')
    .select('*, find_photos(*)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapFind(data) : null;
}

const SOS_SEED = {
  name: 'SOS · Sportswear of Sweden',
  country: '瑞典',
  founded_year: '1982',
  founder: '创始人 Bo Aggerborg；现归属丹麦 Sports Group Denmark（Ole Damm 于 2011 年买入全球品牌权）',
  positioning: '滑雪 / 单板 / 生活方式，中高端户外',
  story:
    'SOS（Sportswear of Sweden）1982 年创立于瑞典滑雪小镇 Åre，主做滑雪服和单板服。\n\n' +
    '创始人是瑞典广告人 Bo Aggerborg。他在 90 年代把品牌卖掉，后来觉得卖亏了，就起诉了买家，最后打赢官司拿回了 SOS 商标。\n\n' +
    '2011 年，在丹麦代理 SOS 多年的 Ole Damm 买下了全球品牌权，总部也搬到了丹麦。他说 SOS 从 1985 年起就是他的「心头宝」。\n\n' +
    '80 年代 SOS 就以大胆、张扬的配色出名，口号是 “Rethink your life in color”。2009 年赞助过瑞典国家雪上技巧队，被滑雪选手称为「一个代表快乐的叛逆滑雪品牌」。',
  interesting:
    '标识很好认：白色三角大 logo。防风针织衫是代表品类之一：外层羊毛+腈纶，里面有防风内衬，拉链常用 YKK。',
  price_notes: '防风针织衫（如 Tignes）官网正价大约 ¥1350–1500；欧洲店打折后常见 ¥840–1240。抓绒、羽绒具体看款，市场尾货价格另计。',
  tags: ['滑雪', '瑞典', '针织', '防风', '户外', 'SOS'],
};

async function ensureSeed() {
  if (brandsCache.length > 0) return;
  const { error } = await supabase.from('brands').insert(SOS_SEED);
  if (error) throw error;
  await loadAll();
}

// ---------- Toast / nav ----------
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

const TITLES = { brands: '品牌', finds: '淘货', search: '搜索', me: '我的' };
let currentTab = 'brands';
let stack = [];

function $(id) { return document.getElementById(id); }

function hideAllViews() {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = true; });
  const main = document.querySelector('main');
  if (main) main.scrollTop = 0;
}

function showTab(tab) {
  stack = [];
  currentTab = tab;
  hideAllViews();
  document.body.classList.remove('detail-mode');
  $('btn-back').hidden = true;
  $('title').textContent = TITLES[tab] || '衣脉';
  $('btn-add').hidden = !(tab === 'brands' || tab === 'finds');
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  $(`view-${tab}`).hidden = false;
  if (tab === 'brands') renderBrandsList();
  if (tab === 'finds') renderFindsList();
  if (tab === 'me') renderMe();
}

function goBack() {
  stack.pop();
  if (stack.length === 0) {
    showTab(currentTab);
    return;
  }
  const top = stack[stack.length - 1];
  hideAllViews();
  document.body.classList.add('detail-mode');
  $('btn-back').hidden = false;
  $('btn-add').hidden = true;
  $('title').textContent = top.title;
  $(top.viewId).hidden = false;
  if (top.viewId === 'view-brand-detail' && top.brandId) openBrandDetail(top.brandId, true);
  if (top.viewId === 'view-find-detail' && top.findId) openFindDetail(top.findId, true);
}

function brandMatches(b, q) {
  if (!q) return true;
  const hay = [
    b.name, b.country, b.foundedYear, b.founderOwner, b.positioning,
    b.story, b.notes, b.priceRef, ...(b.tags || []),
  ].join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function findMatches(f, q, brandMap) {
  if (!q) return true;
  const brand = f.brandId ? brandMap.get(f.brandId) : null;
  const hay = [
    f.notes, f.date,
    brand ? brand.name : '',
    brand ? brand.country : '',
    brand ? (brand.tags || []).join(' ') : '',
  ].join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

// ---------- Brand UI ----------
async function renderBrandsList(opts) {
  if (opts && opts.refresh === true) {
    try {
      await refreshCaches();
    } catch {
      // banner already set
    }
  }
  const q = ($('brands-filter').value || '').trim().toLowerCase();
  const list = brandsCache.filter((b) => brandMatches(b, q));
  const el = $('brands-list');
  const empty = $('brands-empty');
  if (list.length === 0) {
    el.innerHTML = '';
    if (!cacheReady) {
      empty.hidden = true;
      return;
    }
    empty.hidden = false;
    if (brandsCache.length > 0 && q) {
      empty.innerHTML = `<div class="empty-icon">🔍</div><p>没有匹配「${esc(q)}」的品牌</p>`;
    } else {
      empty.innerHTML = `<div class="empty-icon">🏷</div><p>还没有品牌</p><button class="btn primary" data-action="new-brand">添加第一个品牌</button>`;
    }
    return;
  }
  empty.hidden = true;
  const parts = [];
  for (const b of list) {
    const cover = publicUrl(b.coverPath);
    const sub = [b.country, b.foundedYear ? b.foundedYear + ' 年' : ''].filter(Boolean).join(' · ');
    const tags = (b.tags || []).slice(0, 4).map((t) =>
      `<span class="tag${t === '示例' ? ' sample-tag' : ''}">${esc(t)}</span>`
    ).join('');
    parts.push(`
      <button type="button" class="list-item" data-open-brand="${esc(b.id)}">
        <div class="list-thumb">${cover ? `<img src="${cover}" alt="">` : '🏷'}</div>
        <div class="list-body">
          <div class="list-title">${esc(b.name)}</div>
          <p class="list-sub">${esc(sub || b.positioning || '—')}${b.isSample ? ' · 示例可删' : ''}</p>
          ${tags ? `<div class="tags">${tags}</div>` : (b.isSample ? '<div class="tags"><span class="tag sample-tag">示例</span></div>' : '')}
        </div>
      </button>`);
  }
  el.innerHTML = parts.join('');
}

async function openBrandDetail(id, replaceTop) {
  let b;
  try {
    b = await getBrand(id);
    if (!b) {
      await refreshCaches();
      b = await getBrand(id);
    }
  } catch (err) {
    toast(netErr(err));
    return;
  }
  if (!b) { toast('品牌不存在'); return; }
  if (!replaceTop) {
    stack.push({ viewId: 'view-brand-detail', title: b.name, brandId: id });
  } else if (stack.length) {
    stack[stack.length - 1].brandId = id;
    stack[stack.length - 1].title = b.name;
  }
  hideAllViews();
  document.body.classList.add('detail-mode');
  $('btn-back').hidden = false;
  $('btn-add').hidden = true;
  $('title').textContent = b.name;
  $('view-brand-detail').hidden = false;

  const cover = publicUrl(b.coverPath);
  const finds = findsCache.filter((f) => f.brandId === id)
    .sort((a, b2) => (b2.date || '').localeCompare(a.date || ''));

  let findsHtml = '';
  if (finds.length) {
    const items = [];
    for (const f of finds) {
      const thumb = f.photos[0] ? publicUrl(f.photos[0].path) : null;
      items.push(`
        <button type="button" class="list-item" data-open-find="${esc(f.id)}">
          <div class="list-thumb">${thumb ? `<img src="${thumb}" alt="">` : '🧥'}</div>
          <div class="list-body">
            <div class="list-title">${esc(f.date || '未注日期')}</div>
            <p class="list-sub">${esc((f.notes || '').slice(0, 60) || `${f.photos.length} 张照片`)}</p>
          </div>
        </button>`);
    }
    findsHtml = `<div class="section-label">关联淘货 · ${finds.length}</div><div class="list">${items.join('')}</div>`;
  } else {
    findsHtml = `<div class="section-label">关联淘货</div><p class="hint">还没有挂到这个品牌的衣服。<button class="link-btn" data-new-find-for="${esc(id)}">去添加</button></p>`;
  }

  const tags = (b.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');

  $('brand-detail').innerHTML = `
    ${b.isSample ? '<div class="banner sample">这是示例品牌，可以随时编辑或删除。</div>' : ''}
    <div class="card">
      <div class="detail-hero">
        <div class="detail-cover">${cover ? `<img src="${cover}" alt="">` : '🏷'}</div>
        <div>
          <h2 class="detail-name">${esc(b.name)}</h2>
          <p class="detail-sub">${esc([b.country, b.foundedYear ? b.foundedYear + ' 年创立' : ''].filter(Boolean).join(' · ') || '—')}</p>
          ${tags ? `<div class="tags">${tags}</div>` : ''}
        </div>
      </div>
      <div class="detail-actions">
        <button class="btn small" data-edit-brand="${esc(id)}">编辑</button>
        <button class="btn small" data-new-find-for="${esc(id)}">＋ 淘货</button>
        <button class="btn small" data-copy-brand="${esc(id)}">复制文案</button>
      </div>
    </div>
    ${b.positioning ? `<div class="card detail-section"><h3>主打定位</h3><div class="body">${esc(b.positioning)}</div></div>` : ''}
    ${b.founderOwner ? `<div class="card detail-section"><h3>创始人 / 所有者</h3><div class="body">${esc(b.founderOwner)}</div></div>` : ''}
    ${b.story ? `<div class="card detail-section"><h3>品牌故事</h3><div class="body">${esc(b.story)}</div></div>` : ''}
    ${b.notes ? `<div class="card detail-section"><h3>有趣的事</h3><div class="body">${esc(b.notes)}</div></div>` : ''}
    ${b.priceRef ? `<div class="card detail-section"><h3>价位参考</h3><div class="body">${esc(b.priceRef)}</div></div>` : ''}
    ${findsHtml}
  `;
}

let pendingCoverBlob = null;
let pendingCoverPreviewURL = null;
let editingBrandCoverPath = null;
let coverRemoved = false;

function clearCoverPending() {
  pendingCoverBlob = null;
  if (pendingCoverPreviewURL) {
    URL.revokeObjectURL(pendingCoverPreviewURL);
    pendingCoverPreviewURL = null;
  }
}

async function openBrandEdit(id) {
  clearCoverPending();
  coverRemoved = false;
  editingBrandCoverPath = null;
  const isNew = !id;
  let b = null;
  if (!isNew) {
    try { b = await getBrand(id); } catch (err) { toast(netErr(err)); return; }
    if (!b) { toast('品牌不存在'); return; }
  }

  stack.push({ viewId: 'view-brand-edit', title: isNew ? '新品牌' : '编辑品牌', brandId: id });
  hideAllViews();
  document.body.classList.add('detail-mode');
  $('btn-back').hidden = false;
  $('btn-add').hidden = true;
  $('title').textContent = isNew ? '新品牌' : '编辑品牌';
  $('view-brand-edit').hidden = false;

  $('bf-title').textContent = isNew ? '新品牌' : '编辑品牌';
  $('bf-id').value = id || '';
  $('bf-name').value = b ? b.name : '';
  $('bf-country').value = b ? (b.country || '') : '';
  $('bf-year').value = b ? (b.foundedYear || '') : '';
  $('bf-founder').value = b ? (b.founderOwner || '') : '';
  $('bf-positioning').value = b ? (b.positioning || '') : '';
  $('bf-tags').value = b ? tagsToStr(b.tags) : '';
  $('bf-story').value = b ? (b.story || '') : '';
  $('bf-notes').value = b ? (b.notes || '') : '';
  $('bf-price').value = b ? (b.priceRef || '') : '';
  $('bf-delete').hidden = isNew;

  editingBrandCoverPath = b ? b.coverPath : null;
  await renderCoverPreview();
}

async function renderCoverPreview() {
  const grid = $('bf-cover-preview');
  let url = null;
  if (pendingCoverPreviewURL) url = pendingCoverPreviewURL;
  else if (editingBrandCoverPath && !coverRemoved) url = publicUrl(editingBrandCoverPath);
  if (!url) {
    grid.innerHTML = '';
    return;
  }
  grid.innerHTML = `<div class="thumb"><img src="${url}" alt=""><button type="button" aria-label="删除" data-remove-cover>×</button></div>`;
}

async function saveBrand(ev) {
  ev.preventDefault();
  const name = $('bf-name').value.trim();
  if (!name) { toast('请填写品牌名'); return; }

  const existingId = $('bf-id').value || null;
  let existing = null;
  if (existingId) {
    try { existing = await getBrand(existingId); } catch (err) { toast(netErr(err)); return; }
  }

  const id = existingId || uid();
  let coverPath = coverRemoved ? null : (editingBrandCoverPath || null);
  const oldCover = existing ? existing.coverPath : null;

  try {
    if (pendingCoverBlob) {
      const path = `covers/${id}.jpg`;
      await uploadImage(pendingCoverBlob, path);
      coverPath = path;
      if (oldCover && oldCover !== path) await removeStoragePaths([oldCover]);
    } else if (coverRemoved && oldCover) {
      await removeStoragePaths([oldCover]);
      coverPath = null;
    }

    const row = {
      id,
      name,
      country: $('bf-country').value.trim() || null,
      founded_year: $('bf-year').value.trim() || null,
      founder: $('bf-founder').value.trim() || null,
      positioning: $('bf-positioning').value.trim() || null,
      story: $('bf-story').value.trim() || null,
      interesting: $('bf-notes').value.trim() || null,
      price_notes: $('bf-price').value.trim() || null,
      tags: parseTags($('bf-tags').value),
      cover_path: coverPath,
      updated_at: new Date().toISOString(),
    };
    if (!existingId) row.created_at = new Date().toISOString();

    const { error } = await supabase.from('brands').upsert(row);
    if (error) throw error;

    clearCoverPending();
    coverRemoved = false;
    toast('已保存');
    stack = stack.filter((s) => s.viewId !== 'view-brand-edit');
    stack = stack.filter((s) => !(s.viewId === 'view-brand-detail' && s.brandId === id));
    await refreshCaches();
    await openBrandDetail(id);
  } catch (err) {
    console.error(err);
    toast(netErr(err));
  }
}

async function deleteBrandById(id) {
  const b = await getBrand(id);
  // finds: ON DELETE SET NULL — unlink only; delete cover file
  if (b && b.coverPath) await removeStoragePaths([b.coverPath]);
  const { error } = await supabase.from('brands').delete().eq('id', id);
  if (error) throw error;
}

async function copyBrandText(id) {
  const b = await getBrand(id);
  if (!b) return;
  const lines = [
    b.name,
    [b.country, b.foundedYear ? b.foundedYear + ' 年创立' : ''].filter(Boolean).join(' · '),
    b.positioning ? `定位：${b.positioning}` : '',
    b.founderOwner ? `创始人/所有者：${b.founderOwner}` : '',
    '',
    b.story || '',
    '',
    b.notes ? `备注：\n${b.notes}` : '',
    '',
    b.priceRef ? `价位参考：\n${b.priceRef}` : '',
  ];
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    toast('复制失败，请长按选择文字');
  }
}

// ---------- Finds UI ----------
let pendingFindPhotos = []; // { existingId?, path?, blob?, previewURL }

function clearFindPhotosPending() {
  for (const p of pendingFindPhotos) {
    if (p.previewURL && p.blob) URL.revokeObjectURL(p.previewURL);
  }
  pendingFindPhotos = [];
}

async function renderFindsList(opts) {
  if (opts && opts.refresh === true) {
    try {
      await refreshCaches();
    } catch { /* banner */ }
  }
  const brandMap = new Map(brandsCache.map((b) => [b.id, b]));
  const q = ($('finds-filter').value || '').trim().toLowerCase();
  const list = findsCache.filter((f) => findMatches(f, q, brandMap));
  const el = $('finds-list');
  const empty = $('finds-empty');
  if (list.length === 0) {
    el.innerHTML = '';
    if (!cacheReady) {
      empty.hidden = true;
      return;
    }
    empty.hidden = false;
    if (findsCache.length === 0) {
      empty.innerHTML = `<div class="empty-icon">🧥</div><p>还没有淘到的衣服</p><button class="btn primary" data-action="new-find">记录第一件</button>`;
    } else {
      empty.innerHTML = `<div class="empty-icon">🔍</div><p>没有匹配的淘货</p>`;
    }
    return;
  }
  empty.hidden = true;
  const parts = [];
  for (const f of list) {
    const thumb = f.photos[0] ? publicUrl(f.photos[0].path) : null;
    const brand = f.brandId ? brandMap.get(f.brandId) : null;
    parts.push(`
      <button type="button" class="list-item" data-open-find="${esc(f.id)}">
        <div class="list-thumb">${thumb ? `<img src="${thumb}" alt="">` : '🧥'}</div>
        <div class="list-body">
          <div class="list-title">${esc(brand ? brand.name : '未关联品牌')}</div>
          <p class="list-sub">${esc(f.date || '未注日期')}${(f.notes ? ' · ' + f.notes.slice(0, 40) : '')}</p>
          <p class="list-meta">${f.photos.length} 张照片</p>
        </div>
      </button>`);
  }
  el.innerHTML = parts.join('');
}

async function openFindDetail(id, replaceTop) {
  let f;
  try {
    f = await getFind(id);
    if (!f) {
      await refreshCaches();
      f = await getFind(id);
    }
  } catch (err) {
    toast(netErr(err));
    return;
  }
  if (!f) { toast('记录不存在'); return; }
  const brand = f.brandId ? brandsCache.find((b) => b.id === f.brandId) : null;
  const title = brand ? brand.name : '淘货';
  if (!replaceTop) {
    stack.push({ viewId: 'view-find-detail', title, findId: id });
  } else if (stack.length) {
    stack[stack.length - 1].findId = id;
    stack[stack.length - 1].title = title;
  }
  hideAllViews();
  document.body.classList.add('detail-mode');
  $('btn-back').hidden = false;
  $('btn-add').hidden = true;
  $('title').textContent = title;
  $('view-find-detail').hidden = false;

  const photos = f.photos.map((p) => ({ id: p.id, url: publicUrl(p.path) })).filter((p) => p.url);

  $('find-detail').innerHTML = `
    <div class="card">
      <h2 class="detail-name">${esc(brand ? brand.name : '未关联品牌')}</h2>
      <p class="detail-sub">${esc(f.date || '未注日期')}</p>
      <div class="detail-actions">
        <button class="btn small" data-edit-find="${esc(id)}">编辑</button>
        ${brand ? `<button class="btn small" data-open-brand="${esc(brand.id)}">查看品牌</button>` : ''}
      </div>
    </div>
    ${photos.length ? `
      <div class="card">
        <h3>照片 · ${photos.length}</h3>
        <div class="photo-strip">
          ${photos.map((p) => `<div class="thumb" data-lightbox="${p.url}"><img src="${p.url}" alt=""></div>`).join('')}
        </div>
      </div>` : ''}
    ${f.notes ? `<div class="card detail-section"><h3>备注</h3><div class="body">${esc(f.notes)}</div></div>` : ''}
  `;
}

async function fillBrandSelect(selectedId) {
  const sel = $('ff-brand');
  sel.innerHTML = '<option value="">— 暂不关联 —</option>' +
    brandsCache.map((b) =>
      `<option value="${esc(b.id)}"${b.id === selectedId ? ' selected' : ''}>${esc(b.name)}</option>`
    ).join('');
}

async function openFindEdit(id, presetBrandId) {
  clearFindPhotosPending();
  const isNew = !id;
  let f = null;
  if (!isNew) {
    try { f = await getFind(id); } catch (err) { toast(netErr(err)); return; }
    if (!f) { toast('记录不存在'); return; }
  }

  stack.push({ viewId: 'view-find-edit', title: isNew ? '新淘货' : '编辑淘货', findId: id });
  hideAllViews();
  document.body.classList.add('detail-mode');
  $('btn-back').hidden = false;
  $('btn-add').hidden = true;
  $('title').textContent = isNew ? '新淘货' : '编辑淘货';
  $('view-find-edit').hidden = false;

  $('ff-title').textContent = isNew ? '新淘货' : '编辑淘货';
  $('ff-id').value = id || '';
  $('ff-date').value = f ? (f.date || todayISO()) : todayISO();
  $('ff-notes').value = f ? (f.notes || '') : '';
  $('ff-delete').hidden = isNew;
  await fillBrandSelect(f ? f.brandId : presetBrandId);

  if (f) {
    for (const p of f.photos) {
      pendingFindPhotos.push({
        existingId: p.id,
        path: p.path,
        previewURL: publicUrl(p.path),
      });
    }
  }
  renderFindPhotosPreview();
}

function renderFindPhotosPreview() {
  const grid = $('ff-photos');
  if (!pendingFindPhotos.length) {
    grid.innerHTML = '';
    return;
  }
  grid.innerHTML = pendingFindPhotos.map((p, i) =>
    `<div class="thumb"><img src="${p.previewURL}" alt=""><button type="button" aria-label="删除" data-remove-find-photo="${i}">×</button></div>`
  ).join('');
}

async function addFindPhotos(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (pendingFindPhotos.length >= MAX_FIND_PHOTOS) {
      toast(`最多 ${MAX_FIND_PHOTOS} 张`);
      break;
    }
    try {
      const blob = await compressImage(file);
      const previewURL = URL.createObjectURL(blob);
      pendingFindPhotos.push({ blob, previewURL });
    } catch {
      toast('有一张图片处理失败');
    }
  }
  renderFindPhotosPreview();
}

async function saveFind(ev) {
  ev.preventDefault();
  const existingId = $('ff-id').value || null;
  const id = existingId || uid();
  let existing = null;
  if (existingId) {
    try { existing = await getFind(id); } catch (err) { toast(netErr(err)); return; }
  }

  try {
    const findRow = {
      id,
      brand_id: $('ff-brand').value || null,
      found_at: $('ff-date').value || todayISO(),
      notes: $('ff-notes').value.trim() || null,
      updated_at: new Date().toISOString(),
    };
    if (!existingId) findRow.created_at = new Date().toISOString();

    const { error: fErr } = await supabase.from('finds').upsert(findRow);
    if (fErr) throw fErr;

    const keepIds = new Set();
    const photoRows = [];
    let order = 0;

    for (const p of pendingFindPhotos) {
      if (p.existingId && p.path) {
        keepIds.add(p.existingId);
        photoRows.push({
          id: p.existingId,
          find_id: id,
          storage_path: p.path,
          sort_order: order++,
        });
      } else if (p.blob) {
        const pid = uid();
        const path = `finds/${id}/${pid}.jpg`;
        await uploadImage(p.blob, path);
        photoRows.push({
          id: pid,
          find_id: id,
          storage_path: path,
          sort_order: order++,
        });
      }
    }

    // delete removed photo rows + storage
    const oldPhotos = existing ? existing.photos : [];
    const toRemove = oldPhotos.filter((op) => !keepIds.has(op.id));
    if (toRemove.length) {
      await removeStoragePaths(toRemove.map((p) => p.path));
      const { error: dErr } = await supabase
        .from('find_photos')
        .delete()
        .in('id', toRemove.map((p) => p.id));
      if (dErr) throw dErr;
    }

    if (photoRows.length) {
      const { error: pErr } = await supabase.from('find_photos').upsert(photoRows);
      if (pErr) throw pErr;
    }

    clearFindPhotosPending();
    toast('已保存');
    stack = stack.filter((s) => s.viewId !== 'view-find-edit');
    stack = stack.filter((s) => !(s.viewId === 'view-find-detail' && s.findId === id));
    await refreshCaches();
    await openFindDetail(id);
  } catch (err) {
    console.error(err);
    toast(netErr(err));
  }
}

async function deleteFindById(id) {
  const f = await getFind(id);
  if (f && f.photos.length) {
    await removeStoragePaths(f.photos.map((p) => p.path));
  }
  const { error } = await supabase.from('finds').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Search ----------
async function runSearch() {
  const q = ($('global-search').value || '').trim().toLowerCase();
  const results = $('search-results');
  const empty = $('search-empty');
  if (!q) {
    results.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = `<div class="empty-icon">🔍</div><p>输入关键词，搜索你的品牌库和淘货记录</p>`;
    return;
  }
  const brandMap = new Map(brandsCache.map((b) => [b.id, b]));
  const brands = brandsCache.filter((b) => brandMatches(b, q));
  const finds = findsCache.filter((f) => findMatches(f, q, brandMap));

  if (!brands.length && !finds.length) {
    results.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = `<div class="empty-icon">🔍</div><p>没有找到「${esc(q)}」</p>`;
    return;
  }
  empty.hidden = true;
  const parts = [];
  if (brands.length) {
    parts.push(`<div class="section-label">品牌 · ${brands.length}</div>`);
    for (const b of brands) {
      const cover = publicUrl(b.coverPath);
      parts.push(`
        <button type="button" class="list-item" data-open-brand="${esc(b.id)}">
          <div class="list-thumb">${cover ? `<img src="${cover}" alt="">` : '🏷'}</div>
          <div class="list-body">
            <div class="list-title">${esc(b.name)}</div>
            <p class="list-sub">${esc([b.country, b.positioning].filter(Boolean).join(' · ') || '—')}</p>
          </div>
        </button>`);
    }
  }
  if (finds.length) {
    parts.push(`<div class="section-label">淘货 · ${finds.length}</div>`);
    for (const f of finds) {
      const thumb = f.photos[0] ? publicUrl(f.photos[0].path) : null;
      const brand = f.brandId ? brandMap.get(f.brandId) : null;
      parts.push(`
        <button type="button" class="list-item" data-open-find="${esc(f.id)}">
          <div class="list-thumb">${thumb ? `<img src="${thumb}" alt="">` : '🧥'}</div>
          <div class="list-body">
            <div class="list-title">${esc(brand ? brand.name : '未关联品牌')}</div>
            <p class="list-sub">${esc(f.date || '')}${(f.notes ? ' · ' + f.notes.slice(0, 40) : '')}</p>
          </div>
        </button>`);
    }
  }
  results.innerHTML = parts.join('');
}

// ---------- Me / backup ----------
function renderMe() {
  const photoCount = findsCache.reduce((n, f) => n + ((f.photos && f.photos.length) || 0), 0)
    + brandsCache.filter((b) => b.coverPath).length;
  $('stats-text').textContent =
    `品牌 ${brandsCache.length} 个 · 淘货 ${findsCache.length} 条 · 照片约 ${photoCount} 张（云端）`;
  $('app-version').textContent = APP_VERSION;
}

async function exportBackup() {
  try {
    await refreshCaches();
  } catch (err) {
    toast(netErr(err));
    return;
  }
  const payload = {
    app: 'yimai-brand-finder',
    version: APP_VERSION,
    source: 'supabase',
    exportedAt: new Date().toISOString(),
    brands: brandsCache.map((b) => ({
      ...b,
      coverUrl: publicUrl(b.coverPath),
    })),
    finds: findsCache.map((f) => ({
      ...f,
      photos: f.photos.map((p) => ({ ...p, url: publicUrl(p.path) })),
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `yimai-backup-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('已导出备份');
}

async function importBackup(file) {
  let text;
  try { text = await file.text(); } catch { toast('无法读取文件'); return; }
  let data;
  try { data = JSON.parse(text); } catch { toast('不是有效的 JSON'); return; }
  if (!data || !Array.isArray(data.brands) || !Array.isArray(data.finds)) {
    toast('备份格式不对');
    return;
  }
  if (!confirm('导入会覆盖云端全部品牌与淘货数据，确定继续？')) return;

  try {
    // wipe existing (storage files best-effort)
    const oldPaths = [];
    for (const b of brandsCache) if (b.coverPath) oldPaths.push(b.coverPath);
    for (const f of findsCache) for (const p of f.photos) oldPaths.push(p.path);
    await removeStoragePaths(oldPaths);

    // delete rows (find_photos cascade from finds)
    const { error: d1 } = await supabase.from('finds').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (d1) throw d1;
    const { error: d2 } = await supabase.from('brands').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (d2) throw d2;

    for (const b of data.brands) {
      const row = {
        id: b.id || uid(),
        name: b.name,
        country: b.country || null,
        founded_year: b.foundedYear || b.founded_year || null,
        founder: b.founderOwner || b.founder || null,
        story: b.story || null,
        positioning: b.positioning || null,
        interesting: b.notes || b.interesting || null,
        price_notes: b.priceRef || b.price_notes || null,
        tags: b.tags || [],
        cover_path: b.coverPath || b.cover_path || null,
      };
      const { error } = await supabase.from('brands').insert(row);
      if (error) throw error;
    }

    for (const f of data.finds) {
      const fid = f.id || uid();
      const { error } = await supabase.from('finds').insert({
        id: fid,
        brand_id: f.brandId || f.brand_id || null,
        notes: f.notes || null,
        found_at: f.date || f.found_at || null,
      });
      if (error) throw error;

      const photos = f.photos || [];
      // legacy IndexedDB backup: photoIds + separate photos array with dataURL
      if ((!photos.length) && Array.isArray(f.photoIds) && Array.isArray(data.photos)) {
        let order = 0;
        for (const pid of f.photoIds) {
          const src = data.photos.find((p) => p.id === pid);
          if (!src || !src.dataURL) continue;
          const blob = dataURLtoBlob(src.dataURL);
          const path = `finds/${fid}/${pid}.jpg`;
          await uploadImage(blob, path);
          const { error: pe } = await supabase.from('find_photos').insert({
            id: pid,
            find_id: fid,
            storage_path: path,
            sort_order: order++,
          });
          if (pe) throw pe;
        }
      } else {
        let order = 0;
        for (const p of photos) {
          const photoId = p.id || uid();
          let path = p.path || p.storage_path || null;
          if (!path && p.dataURL) {
            const blob = dataURLtoBlob(p.dataURL);
            path = `finds/${fid}/${photoId}.jpg`;
            await uploadImage(blob, path);
          }
          if (!path) continue;
          const { error: pe } = await supabase.from('find_photos').insert({
            id: photoId,
            find_id: fid,
            storage_path: path,
            sort_order: p.sortOrder != null ? p.sortOrder : order++,
          });
          if (pe) throw pe;
        }
      }
    }

    await refreshCaches();
    toast('导入完成');
    showTab('brands');
  } catch (err) {
    console.error(err);
    toast(netErr(err));
  }
}

function dataURLtoBlob(dataURL) {
  const parts = dataURL.split(',');
  const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(parts[1]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ---------- Lightbox ----------
function showLightbox(url) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.innerHTML = `<button class="lightbox-close" aria-label="关闭">×</button><img src="${url}" alt="">`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.classList.contains('lightbox-close')) overlay.remove();
  });
  document.body.appendChild(overlay);
}

// ---------- Wire ----------
function wirePullToRefresh() {
  const THRESHOLD = 64;
  let startY = 0;
  let startX = 0;
  let active = false;
  let pull = 0;
  let refreshing = false;

  const el = document.getElementById('ptr');
  const label = document.getElementById('ptr-label');
  if (!el) return;

  function atTop() {
    const main = document.querySelector('main');
    if (main) return main.scrollTop <= 0;
    return (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0) <= 0;
  }

  function listTab() {
    return !document.body.classList.contains('detail-mode')
      && (currentTab === 'brands' || currentTab === 'finds');
  }

  function place() {
    const bar = document.querySelector('.topbar');
    if (bar) el.style.top = bar.getBoundingClientRect().bottom + 'px';
  }

  function show(px, mode) {
    place();
    if (px <= 0 && mode !== 'refreshing') {
      el.hidden = true;
      el.style.height = '0px';
      el.classList.remove('refreshing');
      return;
    }
    el.hidden = false;
    el.style.height = Math.min(px, 44) + 'px';
    el.classList.toggle('refreshing', mode === 'refreshing');
    if (label) {
      label.textContent = mode === 'refreshing' ? '刷新中…' : mode === 'ready' ? '松开刷新' : '下拉刷新';
    }
  }

  document.addEventListener('touchstart', (e) => {
    active = false;
    pull = 0;
    if (refreshing || !listTab() || e.touches.length !== 1 || !atTop()) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, button, a, label')) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    active = true;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!active || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;
    if (!atTop() || dy <= 0 || Math.abs(dx) > Math.abs(dy) + 6) {
      active = false;
      pull = 0;
      show(0);
      return;
    }
    pull = Math.min(dy * 0.45, 88);
    show(pull, pull >= THRESHOLD ? 'ready' : 'pull');
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  async function endPull() {
    if (!active) return;
    active = false;
    const should = pull >= THRESHOLD && listTab();
    pull = 0;
    if (!should) {
      show(0);
      return;
    }
    refreshing = true;
    show(44, 'refreshing');
    const tab = currentTab;
    try {
      await refreshCaches();
      if (tab === 'brands') await renderBrandsList({ refresh: false });
      else if (tab === 'finds') await renderFindsList({ refresh: false });
    } catch {
      // refreshCaches already shows the net banner
    } finally {
      refreshing = false;
      show(0);
    }
  }

  document.addEventListener('touchend', endPull);
  document.addEventListener('touchcancel', () => {
    active = false;
    pull = 0;
    if (!refreshing) show(0);
  });
}

function wire() {
  wirePullToRefresh();
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });
  $('btn-back').addEventListener('click', goBack);
  $('btn-add').addEventListener('click', () => {
    if (currentTab === 'brands') openBrandEdit(null);
    else if (currentTab === 'finds') openFindEdit(null);
  });

  $('brands-filter').addEventListener('input', () => renderBrandsList());
  $('finds-filter').addEventListener('input', () => renderFindsList());
  $('global-search').addEventListener('input', () => runSearch());

  $('brand-form').addEventListener('submit', saveBrand);
  $('find-form').addEventListener('submit', saveFind);

  $('bf-delete').addEventListener('click', async () => {
    const id = $('bf-id').value;
    if (!id) return;
    if (!confirm('删除这个品牌？关联淘货会解除绑定（照片保留在淘货里）。')) return;
    try {
      await deleteBrandById(id);
      loadGen++;
      brandsCache = brandsCache.filter((b) => b.id !== id);
      for (const f of findsCache) if (f.brandId === id) f.brandId = null;
      persistLocalCache();
      clearCoverPending();
      toast('已删除');
      stack = [];
      showTab('brands');
    } catch (err) {
      toast(netErr(err));
    }
  });

  $('ff-delete').addEventListener('click', async () => {
    const id = $('ff-id').value;
    if (!id) return;
    if (!confirm('删除这条淘货记录？')) return;
    try {
      await deleteFindById(id);
      loadGen++;
      findsCache = findsCache.filter((f) => f.id !== id);
      persistLocalCache();
      clearFindPhotosPending();
      toast('已删除');
      stack = [];
      showTab('finds');
    } catch (err) {
      toast(netErr(err));
    }
  });

  async function onCoverFile(file) {
    if (!file) return;
    try {
      const blob = await compressImage(file);
      clearCoverPending();
      editingBrandCoverPath = null;
      coverRemoved = false;
      pendingCoverBlob = blob;
      pendingCoverPreviewURL = URL.createObjectURL(blob);
      await renderCoverPreview();
    } catch { toast('图片处理失败'); }
  }
  $('bf-cover-camera').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    await onCoverFile(file);
  });
  $('bf-cover-album').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    await onCoverFile(file);
  });

  $('ff-camera').addEventListener('change', async (e) => {
    await addFindPhotos(e.target.files);
    e.target.value = '';
  });
  $('ff-album').addEventListener('change', async (e) => {
    await addFindPhotos(e.target.files);
    e.target.value = '';
  });

  $('btn-export').addEventListener('click', () => exportBackup().catch(() => toast('导出失败')));
  $('input-import').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) await importBackup(file);
  });

  const dismiss = $('dismiss-install');
  if (dismiss) {
    dismiss.addEventListener('click', () => {
      $('install-tip').hidden = true;
      try { localStorage.setItem('yimai-install-dismissed', '1'); } catch {}
    });
  }

  document.body.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action],[data-open-brand],[data-open-find],[data-edit-brand],[data-edit-find],[data-new-find-for],[data-copy-brand],[data-remove-cover],[data-remove-find-photo],[data-lightbox]');
    if (!t) return;

    if (t.dataset.action === 'new-brand') { openBrandEdit(null); return; }
    if (t.dataset.action === 'new-find') { openFindEdit(null); return; }
    if (t.dataset.openBrand) { await openBrandDetail(t.dataset.openBrand); return; }
    if (t.dataset.openFind) { await openFindDetail(t.dataset.openFind); return; }
    if (t.dataset.editBrand) { await openBrandEdit(t.dataset.editBrand); return; }
    if (t.dataset.editFind) { await openFindEdit(t.dataset.editFind); return; }
    if (t.dataset.newFindFor) { await openFindEdit(null, t.dataset.newFindFor); return; }
    if (t.dataset.copyBrand) { await copyBrandText(t.dataset.copyBrand); return; }
    if (t.hasAttribute('data-remove-cover')) {
      clearCoverPending();
      editingBrandCoverPath = null;
      coverRemoved = true;
      await renderCoverPreview();
      return;
    }
    if (t.dataset.removeFindPhoto != null) {
      const i = Number(t.dataset.removeFindPhoto);
      const p = pendingFindPhotos[i];
      if (p && p.previewURL && p.blob) URL.revokeObjectURL(p.previewURL);
      pendingFindPhotos.splice(i, 1);
      renderFindPhotosPreview();
      return;
    }
    if (t.dataset.lightbox) { showLightbox(t.dataset.lightbox); return; }
  });
}

function maybeShowInstallTip() {
  const tip = $('install-tip');
  if (!tip) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem('yimai-install-dismissed') === '1'; } catch {}
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  tip.hidden = dismissed || isStandalone;
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function rerenderVisibleLists() {
  if (document.body.classList.contains('detail-mode')) return;
  if (currentTab === 'brands') renderBrandsList();
  else if (currentTab === 'finds') renderFindsList();
  else if (currentTab === 'search') runSearch();
  else if (currentTab === 'me') renderMe();
}

async function syncFromNetwork(hadSnapshot) {
  const before = cacheSignature();
  try {
    await refreshCaches();
    if (brandsCache.length === 0) {
      try {
        await ensureSeed();
      } catch (err) {
        console.error(err);
        showNetBanner(netErr(err));
      }
    }
  } catch {
    // refreshCaches already shows the net banner; keep the local list
  }
  const changed = cacheSignature() !== before;
  cacheReady = true;
  if (changed || !hadSnapshot) rerenderVisibleLists();
}

function boot() {
  wire();
  maybeShowInstallTip();
  registerSW();
  const hadSnapshot = hydrateLocalCache();
  cacheReady = hadSnapshot;
  showTab('brands');
  syncFromNetwork(hadSnapshot);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
