/* 衣脉 · 个人品牌知识库 — 纯本地，无 AI / 无外部 API */
(() => {
  'use strict';

  const APP_VERSION = '2.0.0';
  const DB_NAME = 'yimai-kb';
  const DB_VER = 1;
  const MAX_FIND_PHOTOS = 12;
  const IMG_MAX_EDGE = 1600;
  const IMG_QUALITY = 0.85;

  // ---------- IndexedDB ----------
  let db;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('brands')) {
          d.createObjectStore('brands', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('finds')) {
          d.createObjectStore('finds', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('photos')) {
          d.createObjectStore('photos', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('meta')) {
          d.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
  }

  function storeGet(store, key) {
    return new Promise((resolve, reject) => {
      const r = store.get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function storeGetAll(store) {
    return new Promise((resolve, reject) => {
      const r = store.getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  }

  function storePut(store, val) {
    return new Promise((resolve, reject) => {
      const r = store.put(val);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function storeDelete(store, key) {
    return new Promise((resolve, reject) => {
      const r = store.delete(key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }

  function storeClear(store) {
    return new Promise((resolve, reject) => {
      const r = store.clear();
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }

  async function getAllBrands() {
    const tx = db.transaction('brands', 'readonly');
    return storeGetAll(tx.objectStore('brands'));
  }

  async function getBrand(id) {
    const tx = db.transaction('brands', 'readonly');
    return storeGet(tx.objectStore('brands'), id);
  }

  async function putBrand(brand) {
    const tx = db.transaction('brands', 'readwrite');
    await storePut(tx.objectStore('brands'), brand);
    await txDone(tx);
  }

  async function deleteBrand(id) {
    const brand = await getBrand(id);
    const finds = (await getAllFinds()).filter((f) => f.brandId === id);
    const tx = db.transaction(['brands', 'finds', 'photos'], 'readwrite');
    const bStore = tx.objectStore('brands');
    const fStore = tx.objectStore('finds');
    const pStore = tx.objectStore('photos');
    if (brand && brand.coverPhotoId) await storeDelete(pStore, brand.coverPhotoId);
    for (const f of finds) {
      for (const pid of f.photoIds || []) await storeDelete(pStore, pid);
      await storeDelete(fStore, f.id);
    }
    await storeDelete(bStore, id);
    await txDone(tx);
  }

  async function getAllFinds() {
    const tx = db.transaction('finds', 'readonly');
    return storeGetAll(tx.objectStore('finds'));
  }

  async function getFind(id) {
    const tx = db.transaction('finds', 'readonly');
    return storeGet(tx.objectStore('finds'), id);
  }

  async function putFind(find) {
    const tx = db.transaction('finds', 'readwrite');
    await storePut(tx.objectStore('finds'), find);
    await txDone(tx);
  }

  async function deleteFind(id) {
    const find = await getFind(id);
    const tx = db.transaction(['finds', 'photos'], 'readwrite');
    const fStore = tx.objectStore('finds');
    const pStore = tx.objectStore('photos');
    if (find) {
      for (const pid of find.photoIds || []) await storeDelete(pStore, pid);
    }
    await storeDelete(fStore, id);
    await txDone(tx);
  }

  async function putPhoto(id, blob) {
    const tx = db.transaction('photos', 'readwrite');
    await storePut(tx.objectStore('photos'), { id, blob, createdAt: Date.now() });
    await txDone(tx);
  }

  async function getPhoto(id) {
    if (!id) return null;
    const tx = db.transaction('photos', 'readonly');
    return storeGet(tx.objectStore('photos'), id);
  }

  async function deletePhoto(id) {
    if (!id) return;
    const tx = db.transaction('photos', 'readwrite');
    await storeDelete(tx.objectStore('photos'), id);
    await txDone(tx);
  }

  async function getMeta(key) {
    const tx = db.transaction('meta', 'readonly');
    const row = await storeGet(tx.objectStore('meta'), key);
    return row ? row.value : undefined;
  }

  async function setMeta(key, value) {
    const tx = db.transaction('meta', 'readwrite');
    await storePut(tx.objectStore('meta'), { key, value });
    await txDone(tx);
  }

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

  function formatDate(iso) {
    if (!iso) return '';
    return iso;
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function dataURLtoBlob(dataURL) {
    const parts = dataURL.split(',');
    const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(parts[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
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

  const objectURLs = new Map();
  async function photoURL(photoId) {
    if (!photoId) return null;
    if (objectURLs.has(photoId)) return objectURLs.get(photoId);
    const row = await getPhoto(photoId);
    if (!row || !row.blob) return null;
    const url = URL.createObjectURL(row.blob);
    objectURLs.set(photoId, url);
    return url;
  }

  function revokeAllURLs() {
    for (const u of objectURLs.values()) URL.revokeObjectURL(u);
    objectURLs.clear();
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  // ---------- Navigation ----------
  const TITLES = {
    brands: '品牌',
    finds: '淘货',
    search: '搜索',
    me: '我的',
  };

  let currentTab = 'brands';
  let stack = []; // detail/edit stack: { view, title, data }

  function $(id) { return document.getElementById(id); }

  function hideAllViews() {
    document.querySelectorAll('.view').forEach((v) => { v.hidden = true; });
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
    if (tab === 'search') { /* keep results */ }
    if (tab === 'me') renderMe();
  }

  function pushView(viewId, title, renderFn) {
    stack.push({ viewId, title });
    hideAllViews();
    document.body.classList.add('detail-mode');
    $('btn-back').hidden = false;
    $('btn-add').hidden = true;
    $('title').textContent = title;
    $(viewId).hidden = false;
    if (renderFn) renderFn();
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
    // re-render based on view
    if (top.viewId === 'view-brand-detail' && top.brandId) openBrandDetail(top.brandId, true);
    if (top.viewId === 'view-find-detail' && top.findId) openFindDetail(top.findId, true);
  }

  // ---------- Seed SOS sample ----------
  const SOS_SAMPLE = {
    id: 'sample-sos',
    name: 'SOS · Sportswear of Sweden',
    country: '瑞典',
    foundedYear: '1982',
    founderOwner: '创始人 Bo Aggerborg；现归属丹麦 Sports Group Denmark（Ole Damm 于 2011 年买入全球品牌权）',
    positioning: '滑雪 / 单板 / 生活方式，中高端户外',
    story:
      'SOS（Sportswear of Sweden）1982 年创立于瑞典滑雪小镇 Åre，主做滑雪服和单板服。\n\n' +
      '创始人是瑞典广告人 Bo Aggerborg。他在 90 年代把品牌卖掉，后来觉得卖亏了，就起诉了买家，最后打赢官司拿回了 SOS 商标。\n\n' +
      '2011 年，在丹麦代理 SOS 多年的 Ole Damm 买下了全球品牌权，总部也搬到了丹麦。他说 SOS 从 1985 年起就是他的「心头宝」。\n\n' +
      '80 年代 SOS 就以大胆、张扬的配色出名，口号是 “Rethink your life in color”。2009 年赞助过瑞典国家雪上技巧队，被滑雪选手称为「一个代表快乐的叛逆滑雪品牌」。',
    notes:
      '标识很好认：白色三角大 logo。防风针织衫是代表品类之一：外层羊毛+腈纶，里面有防风内衬，拉链常用 YKK。\n\n（这是示例品牌，可以随时删除。）',
    priceRef: '防风针织衫（如 Tignes）官网正价大约 ¥1350–1500；欧洲店打折后常见 ¥840–1240。抓绒、羽绒具体看款，市场尾货价格另计。',
    tags: ['滑雪', '瑞典', '针织', '防风', '户外', 'SOS', '示例'],
    coverPhotoId: null,
    isSample: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  async function ensureSeed() {
    const seeded = await getMeta('seeded');
    if (seeded) return;
    const brands = await getAllBrands();
    if (brands.length === 0) {
      await putBrand(SOS_SAMPLE);
    }
    await setMeta('seeded', true);
  }

  // ---------- Brand list / detail / edit ----------
  let brandsCache = [];
  let findsCache = [];

  async function refreshCaches() {
    brandsCache = await getAllBrands();
    brandsCache.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    findsCache = await getAllFinds();
    findsCache.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  }

  function brandMatches(b, q) {
    if (!q) return true;
    const hay = [
      b.name, b.country, b.foundedYear, b.founderOwner, b.positioning,
      b.story, b.notes, b.priceRef, ...(b.tags || []),
    ].join(' ').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  }

  async function renderBrandsList() {
    await refreshCaches();
    const q = ($('brands-filter').value || '').trim().toLowerCase();
    const list = brandsCache.filter((b) => brandMatches(b, q));
    const el = $('brands-list');
    const empty = $('brands-empty');
    if (list.length === 0) {
      el.innerHTML = '';
      empty.hidden = brandsCache.length > 0 && !!q ? false : brandsCache.length === 0;
      if (brandsCache.length > 0 && q) {
        empty.hidden = false;
        empty.innerHTML = `<div class="empty-icon">🔍</div><p>没有匹配「${esc(q)}」的品牌</p>`;
      } else if (brandsCache.length === 0) {
        empty.hidden = false;
        empty.innerHTML = `<div class="empty-icon">🏷</div><p>还没有品牌</p><button class="btn primary" data-action="new-brand">添加第一个品牌</button>`;
      }
      return;
    }
    empty.hidden = true;
    const parts = [];
    for (const b of list) {
      const cover = await photoURL(b.coverPhotoId);
      const sub = [b.country, b.foundedYear ? b.foundedYear + ' 年' : ''].filter(Boolean).join(' · ');
      const tags = (b.tags || []).slice(0, 4).map((t) =>
        `<span class="tag${t === '示例' || b.isSample && t === '示例' ? ' sample-tag' : ''}">${esc(t)}</span>`
      ).join('');
      parts.push(`
        <button type="button" class="list-item" data-open-brand="${esc(b.id)}">
          <div class="list-thumb">${cover ? `<img src="${cover}" alt="">` : '🏷'}</div>
          <div class="list-body">
            <div class="list-title">${esc(b.name)}</div>
            <p class="list-sub">${esc(sub || b.positioning || '—')}${b.isSample ? ' · 示例可删' : ''}</p>
            ${tags ? `<div class="tags">${tags}${b.isSample ? '<span class="tag sample-tag">示例</span>' : ''}</div>` : (b.isSample ? '<div class="tags"><span class="tag sample-tag">示例</span></div>' : '')}
          </div>
        </button>`);
    }
    el.innerHTML = parts.join('');
  }

  async function openBrandDetail(id, replaceTop) {
    const b = await getBrand(id);
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

    const cover = await photoURL(b.coverPhotoId);
    const related = findsCache.filter((f) => f.brandId === id);
    // also refresh finds
    if (!findsCache.length) await refreshCaches();
    const finds = (await getAllFinds()).filter((f) => f.brandId === id)
      .sort((a, b2) => (b2.date || '').localeCompare(a.date || ''));

    let findsHtml = '';
    if (finds.length) {
      const items = [];
      for (const f of finds) {
        const thumbId = (f.photoIds || [])[0];
        const thumb = await photoURL(thumbId);
        items.push(`
          <button type="button" class="list-item" data-open-find="${esc(f.id)}">
            <div class="list-thumb">${thumb ? `<img src="${thumb}" alt="">` : '🧥'}</div>
            <div class="list-body">
              <div class="list-title">${esc(f.date || '未注日期')}</div>
              <p class="list-sub">${esc((f.notes || '').slice(0, 60) || `${(f.photoIds || []).length} 张照片`)}</p>
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

  let pendingCoverBlob = null; // for brand edit
  let pendingCoverPreviewURL = null;
  let editingBrandCoverId = null; // existing photo id to keep

  function clearCoverPending() {
    pendingCoverBlob = null;
    if (pendingCoverPreviewURL) {
      URL.revokeObjectURL(pendingCoverPreviewURL);
      pendingCoverPreviewURL = null;
    }
  }

  async function openBrandEdit(id) {
    clearCoverPending();
    editingBrandCoverId = null;
    const isNew = !id;
    const b = isNew ? null : await getBrand(id);
    if (!isNew && !b) { toast('品牌不存在'); return; }

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

    editingBrandCoverId = b ? b.coverPhotoId : null;
    await renderCoverPreview();
  }

  async function renderCoverPreview() {
    const grid = $('bf-cover-preview');
    let url = null;
    if (pendingCoverPreviewURL) url = pendingCoverPreviewURL;
    else if (editingBrandCoverId) url = await photoURL(editingBrandCoverId);
    if (!url) {
      grid.innerHTML = '';
      return;
    }
    grid.innerHTML = `<div class="thumb"><img src="${url}" alt=""><button type="button" aria-label="删除" data-remove-cover>×</button></div>`;
  }

  async function saveBrand(ev) {
    ev.preventDefault();
    const id = $('bf-id').value || uid();
    const existing = $('bf-id').value ? await getBrand(id) : null;
    let coverPhotoId = editingBrandCoverId;

    if (pendingCoverBlob) {
      // replace cover
      if (existing && existing.coverPhotoId && existing.coverPhotoId !== coverPhotoId) {
        // already handled
      }
      if (existing && existing.coverPhotoId) {
        await deletePhoto(existing.coverPhotoId);
      }
      coverPhotoId = uid();
      await putPhoto(coverPhotoId, pendingCoverBlob);
    } else if (!editingBrandCoverId && existing && existing.coverPhotoId) {
      // user removed cover
      await deletePhoto(existing.coverPhotoId);
      coverPhotoId = null;
    }

    const brand = {
      id,
      name: $('bf-name').value.trim(),
      country: $('bf-country').value.trim(),
      foundedYear: $('bf-year').value.trim(),
      founderOwner: $('bf-founder').value.trim(),
      positioning: $('bf-positioning').value.trim(),
      story: $('bf-story').value.trim(),
      notes: $('bf-notes').value.trim(),
      priceRef: $('bf-price').value.trim(),
      tags: parseTags($('bf-tags').value),
      coverPhotoId: coverPhotoId || null,
      isSample: existing ? !!existing.isSample : false,
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now(),
    };
    if (!brand.name) { toast('请填写品牌名'); return; }
    await putBrand(brand);
    clearCoverPending();
    toast('已保存');
    // go to detail
    stack = stack.filter((s) => s.viewId !== 'view-brand-edit');
    // if came from detail of same brand, pop that too and reopen
    stack = stack.filter((s) => !(s.viewId === 'view-brand-detail' && s.brandId === id));
    await refreshCaches();
    await openBrandDetail(id);
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
    ].filter((l, i, arr) => !(l === '' && (arr[i - 1] === '' || i === 0)));
    const text = lines.join('\n').trim();
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板');
    } catch {
      toast('复制失败，请长按选择文字');
    }
  }

  // ---------- Finds ----------
  let pendingFindPhotos = []; // { id?, blob?, previewURL, existingId? }
  // When editing: existing photos kept as { existingId, previewURL }
  // New photos: { blob, previewURL }

  function clearFindPhotosPending() {
    for (const p of pendingFindPhotos) {
      if (p.previewURL && !p.existingId) URL.revokeObjectURL(p.previewURL);
    }
    pendingFindPhotos = [];
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

  async function renderFindsList() {
    await refreshCaches();
    const brandMap = new Map(brandsCache.map((b) => [b.id, b]));
    const q = ($('finds-filter').value || '').trim().toLowerCase();
    const list = findsCache.filter((f) => findMatches(f, q, brandMap));
    const el = $('finds-list');
    const empty = $('finds-empty');
    if (list.length === 0) {
      el.innerHTML = '';
      if (findsCache.length === 0) {
        empty.hidden = false;
        empty.innerHTML = `<div class="empty-icon">🧥</div><p>还没有淘到的衣服</p><button class="btn primary" data-action="new-find">记录第一件</button>`;
      } else {
        empty.hidden = false;
        empty.innerHTML = `<div class="empty-icon">🔍</div><p>没有匹配的淘货</p>`;
      }
      return;
    }
    empty.hidden = true;
    const parts = [];
    for (const f of list) {
      const thumbId = (f.photoIds || [])[0];
      const thumb = await photoURL(thumbId);
      const brand = f.brandId ? brandMap.get(f.brandId) : null;
      parts.push(`
        <button type="button" class="list-item" data-open-find="${esc(f.id)}">
          <div class="list-thumb">${thumb ? `<img src="${thumb}" alt="">` : '🧥'}</div>
          <div class="list-body">
            <div class="list-title">${esc(brand ? brand.name : '未关联品牌')}</div>
            <p class="list-sub">${esc(f.date || '未注日期')}${(f.notes ? ' · ' + f.notes.slice(0, 40) : '')}</p>
            <p class="list-meta">${(f.photoIds || []).length} 张照片</p>
          </div>
        </button>`);
    }
    el.innerHTML = parts.join('');
  }

  async function openFindDetail(id, replaceTop) {
    const f = await getFind(id);
    if (!f) { toast('记录不存在'); return; }
    const brand = f.brandId ? await getBrand(f.brandId) : null;
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

    const photos = [];
    for (const pid of f.photoIds || []) {
      const url = await photoURL(pid);
      if (url) photos.push({ id: pid, url });
    }

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
    await refreshCaches();
    const sel = $('ff-brand');
    sel.innerHTML = '<option value="">— 暂不关联 —</option>' +
      brandsCache.map((b) =>
        `<option value="${esc(b.id)}"${b.id === selectedId ? ' selected' : ''}>${esc(b.name)}</option>`
      ).join('');
  }

  async function openFindEdit(id, presetBrandId) {
    clearFindPhotosPending();
    const isNew = !id;
    const f = isNew ? null : await getFind(id);
    if (!isNew && !f) { toast('记录不存在'); return; }

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

    if (f && f.photoIds) {
      for (const pid of f.photoIds) {
        const url = await photoURL(pid);
        pendingFindPhotos.push({ existingId: pid, previewURL: url });
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
      } catch (e) {
        toast('有一张图片处理失败');
      }
    }
    renderFindPhotosPreview();
  }

  async function saveFind(ev) {
    ev.preventDefault();
    const id = $('ff-id').value || uid();
    const existing = $('ff-id').value ? await getFind(id) : null;
    const oldIds = new Set(existing ? (existing.photoIds || []) : []);
    const keepIds = new Set();
    const newPhotoIds = [];

    for (const p of pendingFindPhotos) {
      if (p.existingId) {
        keepIds.add(p.existingId);
        newPhotoIds.push(p.existingId);
      } else if (p.blob) {
        const pid = uid();
        await putPhoto(pid, p.blob);
        newPhotoIds.push(pid);
      }
    }
    // delete removed old photos
    for (const oid of oldIds) {
      if (!keepIds.has(oid)) await deletePhoto(oid);
    }

    const find = {
      id,
      brandId: $('ff-brand').value || null,
      date: $('ff-date').value || todayISO(),
      notes: $('ff-notes').value.trim(),
      photoIds: newPhotoIds,
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now(),
    };
    await putFind(find);
    clearFindPhotosPending();
    toast('已保存');
    stack = stack.filter((s) => s.viewId !== 'view-find-edit');
    stack = stack.filter((s) => !(s.viewId === 'view-find-detail' && s.findId === id));
    await refreshCaches();
    await openFindDetail(id);
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
    await refreshCaches();
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
        const cover = await photoURL(b.coverPhotoId);
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
        const thumb = await photoURL((f.photoIds || [])[0]);
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

  // ---------- Me / export import ----------
  async function renderMe() {
    await refreshCaches();
    const photoCount = await countPhotos();
    $('stats-text').textContent =
      `品牌 ${brandsCache.length} 个 · 淘货 ${findsCache.length} 条 · 照片 ${photoCount} 张`;
    $('app-version').textContent = APP_VERSION;
  }

  async function countPhotos() {
    const tx = db.transaction('photos', 'readonly');
    const all = await storeGetAll(tx.objectStore('photos'));
    return all.length;
  }

  async function exportBackup() {
    await refreshCaches();
    const tx = db.transaction('photos', 'readonly');
    const photos = await storeGetAll(tx.objectStore('photos'));
    const photoPayload = [];
    for (const p of photos) {
      const dataURL = await blobToDataURL(p.blob);
      photoPayload.push({ id: p.id, dataURL, createdAt: p.createdAt });
    }
    const payload = {
      app: 'yimai-brand-finder',
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      brands: brandsCache,
      finds: findsCache,
      photos: photoPayload,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
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
    try {
      text = await file.text();
    } catch {
      toast('无法读取文件');
      return;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      toast('不是有效的 JSON');
      return;
    }
    if (!data || !Array.isArray(data.brands) || !Array.isArray(data.finds)) {
      toast('备份格式不对');
      return;
    }
    if (!confirm('导入会覆盖当前全部数据，确定继续？')) return;

    revokeAllURLs();
    const tx = db.transaction(['brands', 'finds', 'photos', 'meta'], 'readwrite');
    await storeClear(tx.objectStore('brands'));
    await storeClear(tx.objectStore('finds'));
    await storeClear(tx.objectStore('photos'));
    await txDone(tx);

    for (const b of data.brands) await putBrand(b);
    for (const f of data.finds) await putFind(f);
    for (const p of data.photos || []) {
      try {
        const blob = dataURLtoBlob(p.dataURL);
        await putPhoto(p.id, blob);
      } catch { /* skip bad photo */ }
    }
    await setMeta('seeded', true);
    await refreshCaches();
    toast('导入完成');
    showTab('brands');
  }

  // ---------- Lightbox ----------
  function showLightbox(url) {
    const overlay = document.createElement('div');
    overlay.className = 'lightbox';
    overlay.innerHTML = `<button class="lightbox-close" aria-label="关闭">×</button><img src="${url}" alt="">`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.classList.contains('lightbox-close')) {
        overlay.remove();
      }
    });
    document.body.appendChild(overlay);
  }

  // ---------- Event wiring ----------
  function wire() {
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
      if (!confirm('删除这个品牌？关联的淘货也会一起删掉。')) return;
      await deleteBrand(id);
      clearCoverPending();
      toast('已删除');
      stack = [];
      showTab('brands');
    });

    $('ff-delete').addEventListener('click', async () => {
      const id = $('ff-id').value;
      if (!id) return;
      if (!confirm('删除这条淘货记录？')) return;
      await deleteFind(id);
      clearFindPhotosPending();
      toast('已删除');
      stack = [];
      showTab('finds');
    });

    // cover photo inputs
    $('bf-cover-camera').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const blob = await compressImage(file);
        clearCoverPending();
        editingBrandCoverId = null;
        pendingCoverBlob = blob;
        pendingCoverPreviewURL = URL.createObjectURL(blob);
        await renderCoverPreview();
      } catch { toast('图片处理失败'); }
    });
    $('bf-cover-album').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const blob = await compressImage(file);
        clearCoverPending();
        editingBrandCoverId = null;
        pendingCoverBlob = blob;
        pendingCoverPreviewURL = URL.createObjectURL(blob);
        await renderCoverPreview();
      } catch { toast('图片处理失败'); }
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

    // delegated clicks
    document.body.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-action],[data-open-brand],[data-open-find],[data-edit-brand],[data-edit-find],[data-new-find-for],[data-copy-brand],[data-remove-cover],[data-remove-find-photo],[data-lightbox]');
      if (!t) return;

      if (t.dataset.action === 'new-brand') { openBrandEdit(null); return; }
      if (t.dataset.action === 'new-find') { openFindEdit(null); return; }
      if (t.dataset.openBrand) {
        // if already in a detail stack and clicking brand from find, just open
        await openBrandDetail(t.dataset.openBrand);
        return;
      }
      if (t.dataset.openFind) { await openFindDetail(t.dataset.openFind); return; }
      if (t.dataset.editBrand) { await openBrandEdit(t.dataset.editBrand); return; }
      if (t.dataset.editFind) { await openFindEdit(t.dataset.editFind); return; }
      if (t.dataset.newFindFor) { await openFindEdit(null, t.dataset.newFindFor); return; }
      if (t.dataset.copyBrand) { await copyBrandText(t.dataset.copyBrand); return; }
      if (t.hasAttribute('data-remove-cover')) {
        clearCoverPending();
        editingBrandCoverId = null;
        await renderCoverPreview();
        return;
      }
      if (t.dataset.removeFindPhoto != null) {
        const i = Number(t.dataset.removeFindPhoto);
        const p = pendingFindPhotos[i];
        if (p && p.previewURL && !p.existingId) URL.revokeObjectURL(p.previewURL);
        pendingFindPhotos.splice(i, 1);
        renderFindPhotosPreview();
        return;
      }
      if (t.dataset.lightbox) { showLightbox(t.dataset.lightbox); return; }
    });
  }

  // ---------- Install tip + SW ----------
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

  // ---------- Boot ----------
  async function boot() {
    try {
      db = await openDB();
      await ensureSeed();
      wire();
      maybeShowInstallTip();
      registerSW();
      showTab('brands');
    } catch (err) {
      console.error(err);
      document.body.innerHTML = `<main style="padding:24px;font-family:sans-serif"><h1>启动失败</h1><p>${esc(err && err.message)}</p><p>请用 Safari / Chrome 打开，并允许本站使用存储。</p></main>`;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
