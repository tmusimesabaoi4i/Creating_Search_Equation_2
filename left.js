/* =========================================================
   left.js - 式作成ツール（left）
   - splitTopLevel/splitTopLevelOnce 未定義エラー修正
   - Mix->Input 逆変換の堅牢化（括弧/{}[]対応, /TX大小許容）
   - クリック遅延対策（イベント委譲 + 分割描画 + localStorageデバウンス）
   - (A+Ａ)/TX 再生成時: (A+Ａ) ではなく A+Ａ（括弧を付けない例外）
   ========================================================= */

(() => {
  'use strict';

  // -------------------------
  // 状態管理
  // -------------------------
  const STORAGE_KEY = 'biz_tool_mix_items';
  const VIRTUAL_THRESHOLD = 200; // この件数を超えたら仮想化
  const OVERSCAN = 5; // 可視範囲外の上下に追加で描画する件数
  
  const state = {
    mode: '1',
    mode3Type: 'A',
    sortLenDesc: true, // true: 長い→短い, false: 短い→長い
    mixItems: [], // { id, text, selected }
    
    // 仮想化用
    virtual: {
      enabled: false,
      itemHeight: 0,
      scrollTop: 0,
      visibleStart: 0,
      visibleEnd: 0,
      scrollEl: null,
      spacerEl: null,
      viewportEl: null,
      ticking: false
    }
  };

  // -------------------------
  // DOM
  // -------------------------
  const inputContainer = document.getElementById('input-container');
  const layerIn = document.getElementById('layer-in');
  const modeRadios = Array.from(document.getElementsByName('mode'));
  const mode3Options = document.getElementById('mode3-options');
  const mode3Radios = Array.from(document.getElementsByName('mode3type'));

  const mixListEl = document.getElementById('mix-list');
  const finalOutput = document.getElementById('final-output');

  const btnGenerate = document.getElementById('btn-generate');
  const btnCreateFinal = document.getElementById('btn-create-final');
  const btnDecomposeMix = document.getElementById('btn-decompose-mix');
  const btnCopy = document.getElementById('btn-copy');
  const btnEditSelected = document.getElementById('btn-edit-selected');
  const btnClearMix = document.getElementById('btn-clear-mix');
  const btnToggleAll = document.getElementById('btn-toggle-all');
  const btnSortLength = document.getElementById('btn-sort-length');

  // -------------------------
  // Toast
  // -------------------------
  const toastContainer = document.getElementById('toast-container');

  function showToast(message, type = 'info', ms = 2000) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const msg = document.createElement('div');
    msg.className = 'toast-msg';
    msg.textContent = message;

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.type = 'button';
    close.textContent = '×';
    close.onclick = () => dismissToast(toast);

    toast.append(msg, close);
    toastContainer.appendChild(toast);

    const timer = window.setTimeout(() => dismissToast(toast), ms);
    toast.dataset.timer = String(timer);
  }

  function dismissToast(toastEl) {
    if (!toastEl || !toastEl.isConnected) return;
    const timer = toastEl.dataset.timer ? Number(toastEl.dataset.timer) : null;
    if (timer) window.clearTimeout(timer);

    toastEl.classList.add('out');
    window.setTimeout(() => {
      if (toastEl && toastEl.isConnected) toastEl.remove();
    }, 180);
  }

  // -------------------------
  // 基本ユーティリティ
  // -------------------------
  function normalizeFormulaText(text) {
    return String(text ?? '').trim();
  }

  function newId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return String(Date.now()) + '_' + String(Math.random()).slice(2);
  }

  // /TX 大小許容
  function hasTxSuffix(s) {
    return /\/tx$/i.test(String(s ?? '').trim());
  }
  function stripTxSuffix(s) {
    return String(s ?? '').trim().replace(/\/tx$/i, '').trim();
  }

  // -------------------------
  // 文字列ユーティリティ（全角/半角）
  // -------------------------
  function toHalfWidth(str) {
    return String(str ?? '')
      .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ');
  }

  function toFullWidth(str) {
    return String(str ?? '')
      .replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xFEE0))
      .replace(/ /g, '　');
  }

  function isAlphaNum(str) {
    return /^[0-9A-Za-z]+$/.test(str);
  }

  /**
   * Input->Mix用に単語を正規化する
   * - 半角化
   * - '+'分割（無くても1語扱い）→長い順
   * - 英数字だけのトークンは「全角版」「半角版」を追加
   * - 再ソート&重複排除
   * - '+'結合
   */
  function normalizeWordForMix(rawWord) {
    const half = toHalfWidth(String(rawWord ?? '')).trim();
    if (!half) return '';

    const baseTokens = half
      .split('+')
      .map((s) => s.trim())
      .filter(Boolean);

    baseTokens.sort((a, b) => (b.length - a.length) || a.localeCompare(b));

    const expanded = [];
    for (const t of baseTokens) {
      if (isAlphaNum(t)) {
        expanded.push(t);
        expanded.push(toFullWidth(t));
      } else {
        expanded.push(t);
      }
    }

    expanded.sort((a, b) => (b.length - a.length) || a.localeCompare(b));

    const seen = new Set();
    const deduped = [];
    for (const t of expanded) {
      if (!seen.has(t)) {
        seen.add(t);
        deduped.push(t);
      }
    }

    if (deduped.length <= 1) return deduped[0] ?? '';

    const joined = deduped.join('+');

    return `(${joined})`;
  }

  /**
   * class（FT/CP）モード用の軽い正規化
   * - 前後空白除去
   * - 全角英数/記号は半角へ（入力ゆれ吸収）
   * - '+'分割や並べ替えはしない（入力順を維持）
   */
  function normalizeWordForClass(rawWord) {
    return toHalfWidth(String(rawWord ?? '')).trim();
  }

  // -------------------------
  // トップレベル split（括弧内の区切りは無視）
  // -------------------------
  const _OPEN = new Set(['(', '{', '[']);
  const _CLOSE = new Set([')', '}', ']']);
  const _PAIR = { '(': ')', '{': '}', '[': ']' };

  function splitTopLevel(str, separatorChar) {
    const s = String(str ?? '');
    const sep = String(separatorChar ?? '');
    if (sep.length !== 1) return [s];

    const out = [];
    let start = 0;
    const stack = [];

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];

      if (_OPEN.has(ch)) { stack.push(ch); continue; }
      if (_CLOSE.has(ch)) {
        const last = stack[stack.length - 1];
        if (last && _PAIR[last] === ch) stack.pop();
        continue;
      }

      if (ch === sep && stack.length === 0) {
        out.push(s.slice(start, i));
        start = i + 1;
      }
    }
    out.push(s.slice(start));
    return out;
  }

  function findMatchingBracket(str, openIndex) {
    const s = String(str ?? '');
    if (openIndex < 0 || openIndex >= s.length) return -1;

    const open = s[openIndex];
    const close = _PAIR[open];
    if (!close) return -1;

    const stack = [open];
    for (let i = openIndex + 1; i < s.length; i++) {
      const ch = s[i];
      if (_OPEN.has(ch)) stack.push(ch);
      else if (_CLOSE.has(ch)) {
        const last = stack[stack.length - 1];
        if (last && _PAIR[last] === ch) {
          stack.pop();
          if (stack.length === 0) return i;
        } else {
          return -1;
        }
      }
    }
    return -1;
  }

  // 3-C用: トップレベルの「/TX+」(大小許容)で左右分割
  // これなら A+Ａ のように単語内に + があっても壊れない
  function splitParallelInner(inner) {
    const s = String(inner ?? '');
    const stack = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];

      if (_OPEN.has(ch)) { stack.push(ch); continue; }
      if (_CLOSE.has(ch)) {
        const last = stack[stack.length - 1];
        if (last && _PAIR[last] === ch) stack.pop();
        continue;
      }

      if (ch === '+' && stack.length === 0) {
        if (i >= 3) {
          const prev3 = s.slice(i - 3, i).toUpperCase(); // "/TX"
          if (prev3 === '/TX') {
            return [s.slice(0, i), s.slice(i + 1)];
          }
        }
      }
    }
    return null;
  }

  // -------------------------
  // Mix Toolbar
  // -------------------------
  function updateToggleAllButton() {
    if (!btnToggleAll) return;
    const hasItems = state.mixItems.length > 0;
    btnToggleAll.disabled = !hasItems;

    if (!hasItems) {
      btnToggleAll.textContent = '全ON';
      return;
    }
    const allSelected = state.mixItems.every((i) => !!i.selected);
    btnToggleAll.textContent = allSelected ? '全OFF' : '全ON';
  }

  function updateSortLengthButton() {
    if (!btnSortLength) return;
    btnSortLength.disabled = state.mixItems.length < 2;
  }

  function updateMixToolbarButtons() {
    updateToggleAllButton();
    updateSortLengthButton();
  }

  function toggleAllSelection() {
    if (state.mixItems.length === 0) {
      showToast('Mixは空です', 'info', 1400);
      return;
    }
    const allSelected = state.mixItems.every((i) => !!i.selected);
    const next = !allSelected;
    state.mixItems.forEach((i) => { i.selected = next; });
    renderMix();
    saveToStorage();
  }

  function sortMixByLength() {
    if (state.mixItems.length < 2) return;

    state.mixItems.sort((a, b) => {
      const ta = normalizeFormulaText(a.text);
      const tb = normalizeFormulaText(b.text);
      const la = ta.length;
      const lb = tb.length;
      if (la !== lb) return state.sortLenDesc ? (lb - la) : (la - lb);
      return ta.localeCompare(tb);
    });

    state.sortLenDesc = !state.sortLenDesc;
    renderMix();
    saveToStorage();
  }

  // -------------------------
  // View: 入力欄描画
  // -------------------------
  function renderInputs() {
    if (!inputContainer) return;
    inputContainer.innerHTML = '';
    if (mode3Options) mode3Options.style.display = (state.mode === '3') ? 'block' : 'none';
    if (layerIn) layerIn.classList.toggle('mode3-active', state.mode === '3');

    const createWordInput = (placeholder) =>
      `<input type="text" class="inp-word" placeholder="${placeholder}" />`;

    const createNumInput = (placeholder = 'n', value = '1') =>
      `<input type="number" class="inp-num" placeholder="${placeholder}" value="${value}" min="0" />`;

    const DEFAULT_N = {
      mode2: '30',
      mode3A: '30',
      mode3B: '30',
      mode3C: '5',
    };

    let html = '';

    if (state.mode === '1') {
      html += `<div class="input-row">${createWordInput('単語1')}</div>`;
    } else if (state.mode === 'class') {
      html += `<div class="input-row">${createWordInput('分類コード（例: H04W12/08+H04W72/12）')}</div>`;
    } else if (state.mode === '2') {
      html += `<div class="input-row">${createWordInput('単語1')}</div>`;
      html += `<div class="input-row">n: ${createNumInput('n', DEFAULT_N.mode2)}</div>`;
      html += `<div class="input-row">${createWordInput('単語2')}</div>`;
    } else if (state.mode === '3') {
      if (state.mode3Type === 'A') {
        // 直列: {A, n, B, n, C}/TX
        html += `
          <div class="mode3-card">
            <div class="mode3-bracket mode3-bracket--open">{</div>
            <div class="mode3-body">
              <div class="input-row"><label class="mode3-label">A</label>${createWordInput('単語A')}</div>
              <div class="input-row"><label class="mode3-label">n</label>${createNumInput('n', DEFAULT_N.mode3A)}</div>
              <div class="input-row"><label class="mode3-label">B</label>${createWordInput('単語B')}</div>
              <div class="input-row"><label class="mode3-label">C</label>${createWordInput('単語C')}</div>
            </div>
            <div class="mode3-bracket mode3-bracket--close">}/TX</div>
          </div>`;
      } else if (state.mode3Type === 'B') {
        // 集合: {A, B, C}, n/TX
        html += `
          <div class="mode3-card mode3-card--collection">
            <div class="mode3-bracket mode3-bracket--open">{</div>
            <div class="mode3-body">
              <div class="input-row"><label class="mode3-label">A</label>${createWordInput('単語A')}</div>
              <div class="input-row"><label class="mode3-label">B</label>${createWordInput('単語B')}</div>
              <div class="input-row"><label class="mode3-label">C</label>${createWordInput('単語C')}</div>
            </div>
            <div class="mode3-bracket mode3-bracket--close">}</div>
            <div class="mode3-suffix"><label class="mode3-label">n</label>${createNumInput('n', DEFAULT_N.mode3B)}<span class="mode3-tx">/TX</span></div>
          </div>`;
      } else {
        // 並列: [A/TX + B, n, C/TX]
        html += `
          <div class="mode3-card mode3-card--parallel">
            <div class="mode3-bracket mode3-bracket--open">[</div>
            <div class="mode3-body">
              <div class="mode3-parallel-row">
                <span class="mode3-side-label">左</span>
                <div class="input-row">${createWordInput('単語A')}<span class="mode3-tx">/TX</span></div>
              </div>
              <div class="mode3-parallel-row">
                <span class="mode3-side-label">右</span>
                <div class="input-row">
                  ${createWordInput('単語B')}
                  <span class="mode3-comma">,</span>
                  <label class="mode3-label">n</label>${createNumInput('n', DEFAULT_N.mode3C)}
                  <span class="mode3-comma">,</span>
                  ${createWordInput('単語C')}<span class="mode3-tx">/TX</span>
                </div>
              </div>
            </div>
            <div class="mode3-bracket mode3-bracket--close">]</div>
          </div>`;
      }
    }

    inputContainer.innerHTML = html;
  }

  // -------------------------
  // Logic: Input -> Mix
  // -------------------------
  function generateFormula() {
    const wordInputs = Array.from(document.querySelectorAll('.inp-word'));
    const numInputs = Array.from(document.querySelectorAll('.inp-num'));

    const rawWords = wordInputs.map((i) => i.value.trim());
    const nums = numInputs.map((i) => String(i.value ?? '').trim());

    if (state.mode === 'class') {
      const raw = rawWords[0] ?? '';
      const x = normalizeWordForClass(raw);
      if (!x) {
        showToast('分類コードを入力してください', 'error', 2400);
        return;
      }

      const hasPlus = x.includes('+');
      const alreadyWrapped = x.startsWith('(') && x.endsWith(')');
      const xw = (hasPlus && !alreadyWrapped) ? `(${x})` : x;
      const result = `[${xw}/FT+${xw}/CP]`;
      if (addToMix(result)) showToast('Mixに追加しました', 'success', 1400);
      return;
    }

    if (rawWords.some((w) => w === '')) {
      showToast('単語を入力してください', 'error', 2400);
      return;
    }

    const words = rawWords.map(normalizeWordForMix);
    let result = '';

    // 数値の後ろに "N" を付加するヘルパー
    const formatN = (val) => (val || '1') + 'N';

    if (state.mode === '1') {
      result = `${words[0]}/TX`;
    } else if (state.mode === '2') {
      // 例: word,30N,word/TX
      result = `${words[0]},${formatN(nums[0])},${words[1]}/TX`;
    } else if (state.mode === '3') {
      const nStr = formatN(nums[0]);
      if (state.mode3Type === 'A') {
        // 例: {A,30N,B,30N,C}/TX
        result = `{${words[0]},${nStr},${words[1]},${nStr},${words[2]}}/TX`;
      } else if (state.mode3Type === 'B') {
        // 例: {A,B,C},30N/TX
        result = `{${words[0]},${words[1]},${words[2]}},${nStr}/TX`;
      } else {
        // 例: [A/TX+B,30N,C/TX]
        result = `[${words[0]}/TX+${words[1]},${nStr},${words[2]}/TX]`;
      }
    }

    if (addToMix(result)) showToast('Mixに追加しました', 'success', 1400);
  }

  // -------------------------
  // Mix（高速化: イベント委譲 + 分割描画）
  // -------------------------
  let draggingIndex = null;
  let _renderVer = 0;

  function buildMixItemLi(item, index) {
    const li = document.createElement('li');
    li.className = 'mix-item';
    li.draggable = true;
    li.dataset.index = String(index);

    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    handle.title = 'ドラッグで並び替え';
    handle.textContent = '☰';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'mix-select';
    chk.dataset.index = String(index);
    chk.checked = !!item.selected;

    const span = document.createElement('span');
    span.className = 'mix-text';
    span.dataset.index = String(index);
    span.textContent = item.text;
    span.title = 'クリックでInputへ展開';

    const actions = document.createElement('div');
    actions.className = 'mix-actions';

    const mkBtn = (label, title, action) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn--sm btn--ghost mix-action';
      b.textContent = label;
      b.title = title;
      b.dataset.action = action;
      b.dataset.index = String(index);
      return b;
    };

    actions.append(
      mkBtn('Edit', 'Inputへ展開', 'edit'),
      mkBtn('↑', '上へ', 'up'),
      mkBtn('↓', '下へ', 'down'),
      mkBtn('×', '削除', 'delete')
    );

    li.append(handle, chk, span, actions);
    return li;
  }

  function bindMixDelegates() {
    if (!mixListEl || mixListEl.dataset.bound === '1') return;
    mixListEl.dataset.bound = '1';

    // イベント委譲：仮想化時でもbodyで拾う
    document.body.addEventListener('change', (e) => {
      const chk = e.target.closest('input.mix-select');
      if (!chk) return;
      const idx = Number(chk.dataset.index);
      if (!Number.isFinite(idx) || !state.mixItems[idx]) return;
      state.mixItems[idx].selected = chk.checked;
      saveToStorage();
      updateToggleAllButton();
    });

    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('button.mix-action');
      if (btn) {
        const idx = Number(btn.dataset.index);
        if (!Number.isFinite(idx) || !state.mixItems[idx]) return;
        const action = btn.dataset.action;

        if (action === 'edit') {
          decomposeToInput(state.mixItems[idx].text);
          return;
        }
        if (action === 'up') {
          moveItem(idx, Math.max(0, idx - 1));
          return;
        }
        if (action === 'down') {
          moveItem(idx, Math.min(state.mixItems.length - 1, idx + 1));
          return;
        }
        if (action === 'delete') {
          state.mixItems.splice(idx, 1);
          renderMix();
          saveToStorage();
          return;
        }
      }

      const span = e.target.closest('span.mix-text');
      if (span) {
        const idx = Number(span.dataset.index);
        if (!Number.isFinite(idx) || !state.mixItems[idx]) return;
        decomposeToInput(state.mixItems[idx].text);
      }
    });

    document.body.addEventListener('dragstart', (e) => {
      const li = e.target.closest('li.mix-item');
      if (!li) return;
      
      // 仮想化時は可視範囲外へのドラッグを防ぐため、ドラッグ元をチェック
      const idx = Number(li.dataset.index);
      if (!Number.isFinite(idx)) return;
      
      if (state.virtual.enabled) {
        // 仮想化時：可視範囲内のみ許可
        if (idx < state.virtual.visibleStart || idx >= state.virtual.visibleEnd) {
          e.preventDefault();
          showToast('可視範囲内でのみドラッグできます', 'info', 1800);
          return;
        }
      }
      
      draggingIndex = idx;
      li.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', String(idx));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });

    document.body.addEventListener('dragend', (e) => {
      const li = e.target.closest('li.mix-item');
      if (li) li.classList.remove('dragging');
      draggingIndex = null;
    });

    document.body.addEventListener('dragover', (e) => {
      const li = e.target.closest('li.mix-item');
      if (!li) return;
      
      // 仮想化時は可視範囲内のみ許可
      if (state.virtual.enabled) {
        const idx = Number(li.dataset.index);
        if (!Number.isFinite(idx) || idx < state.virtual.visibleStart || idx >= state.virtual.visibleEnd) {
          return; // dropを許可しない
        }
      }
      
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });

    document.body.addEventListener('drop', (e) => {
      const li = e.target.closest('li.mix-item');
      if (!li) return;
      
      e.preventDefault();
      const to = Number(li.dataset.index);
      const from = draggingIndex ?? Number(e.dataTransfer?.getData('text/plain'));
      
      // 仮想化時は可視範囲内のみ許可
      if (state.virtual.enabled) {
        if (from < state.virtual.visibleStart || from >= state.virtual.visibleEnd ||
            to < state.virtual.visibleStart || to >= state.virtual.visibleEnd) {
          showToast('可視範囲内でのみドラッグできます', 'warn', 1800);
          return;
        }
      }
      
      if (Number.isFinite(from) && Number.isFinite(to)) moveItem(from, to);
    });
  }

  // -------------------------
  // 仮想スクロール：ヘルパー関数
  // -------------------------
  
  function measureItemHeight() {
    // 1件だけ描画して高さを測定
    if (state.mixItems.length === 0) return 36; // デフォルト
    
    const temp = buildMixItemLi(state.mixItems[0], 0);
    temp.style.position = 'absolute';
    temp.style.visibility = 'hidden';
    mixListEl.appendChild(temp);
    const height = temp.getBoundingClientRect().height;
    temp.remove();
    return height || 36;
  }
  
  function setupVirtualScroll() {
    const total = state.mixItems.length;
    
    // しきい値を超えていなければ通常モード
    if (total <= VIRTUAL_THRESHOLD) {
      state.virtual.enabled = false;
      return;
    }
    
    state.virtual.enabled = true;
    
    // DOM構造を作成
    if (!state.virtual.scrollEl) {
      const section = document.getElementById('layer-mix');
      const oldList = mixListEl;
      
      // スクロールコンテナ
      const scrollEl = document.createElement('div');
      scrollEl.id = 'mix-scroll';
      scrollEl.className = 'mix-scroll';
      
      // スペーサー
      const spacerEl = document.createElement('div');
      spacerEl.id = 'mix-spacer';
      spacerEl.className = 'mix-spacer';
      
      // ビューポート（既存のul要素を流用）
      oldList.className = 'mix-list virtualized mix-viewport';
      oldList.id = 'mix-viewport';
      
      spacerEl.appendChild(oldList);
      scrollEl.appendChild(spacerEl);
      
      // 既存のリストを置き換え
      oldList.parentElement.replaceChild(scrollEl, oldList);
      
      state.virtual.scrollEl = scrollEl;
      state.virtual.spacerEl = spacerEl;
      state.virtual.viewportEl = oldList;
      
      // スクロールイベント
      scrollEl.addEventListener('scroll', onVirtualScroll);
      window.addEventListener('resize', onVirtualResize);
    }
    
    // 行高を測定
    if (!state.virtual.itemHeight) {
      state.virtual.itemHeight = measureItemHeight();
    }
  }
  
  function teardownVirtualScroll() {
    if (!state.virtual.scrollEl) return;
    
    const scrollEl = state.virtual.scrollEl;
    const viewportEl = state.virtual.viewportEl;
    
    // イベント解除
    scrollEl.removeEventListener('scroll', onVirtualScroll);
    window.removeEventListener('resize', onVirtualResize);
    
    // DOM構造を元に戻す
    viewportEl.className = 'mix-list';
    viewportEl.id = 'mix-list';
    viewportEl.style.transform = '';
    
    scrollEl.parentElement.replaceChild(viewportEl, scrollEl);
    
    state.virtual.scrollEl = null;
    state.virtual.spacerEl = null;
    state.virtual.viewportEl = null;
    state.virtual.enabled = false;
  }
  
  function onVirtualScroll() {
    if (state.virtual.ticking) return;
    state.virtual.ticking = true;
    
    requestAnimationFrame(() => {
      state.virtual.ticking = false;
      renderVirtualRange();
    });
  }
  
  function onVirtualResize() {
    if (!state.virtual.enabled) return;
    renderVirtualRange();
  }
  
  function renderVirtualRange() {
    if (!state.virtual.enabled || !state.virtual.scrollEl) return;
    
    const total = state.mixItems.length;
    const itemH = state.virtual.itemHeight;
    const scrollTop = state.virtual.scrollEl.scrollTop;
    const clientHeight = state.virtual.scrollEl.clientHeight;
    
    // 可視範囲の計算
    const startIndex = Math.max(0, Math.floor(scrollTop / itemH) - OVERSCAN);
    const visibleCount = Math.ceil(clientHeight / itemH);
    const endIndex = Math.min(total, startIndex + visibleCount + OVERSCAN * 2);
    
    // 変更がなければスキップ
    if (startIndex === state.virtual.visibleStart && endIndex === state.virtual.visibleEnd) {
      return;
    }
    
    state.virtual.visibleStart = startIndex;
    state.virtual.visibleEnd = endIndex;
    
    // スペーサーの高さ設定
    const totalHeight = total * itemH;
    state.virtual.spacerEl.style.height = `${totalHeight}px`;
    
    // ビューポートの位置
    const offsetY = startIndex * itemH;
    state.virtual.viewportEl.style.transform = `translateY(${offsetY}px)`;
    
    // 可視範囲のアイテムを描画
    const frag = document.createDocumentFragment();
    for (let i = startIndex; i < endIndex; i++) {
      frag.appendChild(buildMixItemLi(state.mixItems[i], i));
    }
    
    state.virtual.viewportEl.textContent = '';
    state.virtual.viewportEl.appendChild(frag);
  }
  
  // -------------------------
  // Mix レンダリング（仮想化対応）
  // -------------------------
  
  function renderMix() {
    _renderVer += 1;
    updateMixToolbarButtons();
    
    const total = state.mixItems.length;
    
    if (total === 0) {
      // 空の場合：仮想化を解除して空表示
      if (state.virtual.enabled) teardownVirtualScroll();
      if (mixListEl) mixListEl.textContent = '';
      return;
    }
    
    // しきい値判定
    if (total > VIRTUAL_THRESHOLD) {
      // 仮想化モード
      setupVirtualScroll();
      renderVirtualRange();
    } else {
      // 通常モード（全件描画）
      if (state.virtual.enabled) teardownVirtualScroll();
      
      const listEl = document.getElementById('mix-list');
      if (!listEl) return;
      
      listEl.textContent = '';
      const frag = document.createDocumentFragment();
      for (let i = 0; i < total; i++) {
        frag.appendChild(buildMixItemLi(state.mixItems[i], i));
      }
      listEl.appendChild(frag);
    }
  }

  // -------------------------
  // Mix -> Output
  // -------------------------
  function createFinalString() {
    const selected = state.mixItems.filter((i) => i.selected).map((i) => i.text);
    if (selected.length === 0) {
      showToast('Mix層で項目を選択してください', 'error', 2400);
      return;
    }
    if (finalOutput) finalOutput.value = selected.join('*');
    showToast('Outputに反映しました', 'success', 1400);
  }

  async function copyOutput() {
    const text = finalOutput?.value ?? '';
    if (!text) {
      showToast('コピーする内容がありません', 'warn', 1800);
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        finalOutput.focus();
        finalOutput.select();
        document.execCommand('copy');
      }
      showToast('コピーしました', 'success', 1600);
    } catch {
      showToast('コピーに失敗しました（ブラウザ権限を確認）', 'error', 2600);
    }
  }

  // -------------------------
  // Output -> Mix（逆変換）
  // -------------------------
  function decomposeToMix() {
    const raw = (finalOutput?.value ?? '').trim();
    if (!raw) {
      showToast('Outputが空です', 'warn', 1800);
      return;
    }
    const parts = raw.split('*').map((s) => s.trim()).filter(Boolean);

    const seen = new Set();
    state.mixItems = [];
    let dup = 0;

    for (const p of parts) {
      const key = normalizeFormulaText(p);
      if (!key) continue;
      if (seen.has(key)) { dup++; continue; }
      seen.add(key);
      state.mixItems.push({ id: newId(), text: key, selected: true });
    }

    renderMix();
    saveToStorage();
    if (dup) showToast(`Mixへ分解（重複${dup}件除外）`, 'warn', 2200);
    else showToast('Mixへ分解しました', 'success', 1400);
  }

  // -------------------------
  // Mix Item -> Input（完全逆変換）
  // -------------------------
  function decomposeToInput(formula) {
    const raw = String(formula ?? '').trim();
    if (!raw) return;

    // --- ヘルパー関数 ---
    const stripParentheses = (s) => {
      let str = s.trim();
      while (str.length >= 2 && str.startsWith('(') && str.endsWith(')')) {
        str = str.slice(1, -1).trim();
      }
      return str;
    };

    const stripOneParenthesis = (s) => {
      const str = String(s ?? '').trim();
      if (str.length >= 2 && str.startsWith('(') && str.endsWith(')')) {
        return str.slice(1, -1).trim();
      }
      return str;
    };

    // "30N" から "30" を取り出す (大文字小文字許容)
    const extractNum = (s) => {
      const m = s.trim().match(/^(\d+)[nN]$/);
      return m ? m[1] : s.trim();
    };

    // 数値部分が "数字+N" か判定する
    const isNFormat = (s) => /^(\d+)[nN]$/.test(s.trim());

    // 3-C: [A/TX + B,nN,C/TX]
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim();
      const lr = splitParallelInner(inner);
      if (lr) {
        const left = lr[0].trim();
        const right = lr[1].trim();
        if (hasTxSuffix(left) && hasTxSuffix(right)) {
          const wordA = stripParentheses(stripTxSuffix(left));
          const rightCore = stripTxSuffix(right);
          const parts = splitTopLevel(rightCore, ',').map((s) => s.trim());
          
          if (parts.length === 3 && isNFormat(parts[1])) {
            setMode('3', 'C');
            queueMicrotask(() => fillInputs([wordA, stripParentheses(parts[0]), stripParentheses(parts[2])], [extractNum(parts[1])]));
            return;
          }
        }
      }

      // class（FT/CP）: [Xw/FT + Xw/CP]（Xwは必要に応じて括弧付き）
      const plusParts = splitTopLevel(inner, '+').map((s) => s.trim());
      if (plusParts.length === 2) {
        const l = plusParts[0];
        const r = plusParts[1];
        if (/\/ft$/i.test(l) && /\/cp$/i.test(r)) {
          const baseL = l.replace(/\/ft$/i, '').trim();
          const baseR = r.replace(/\/cp$/i, '').trim();
          if (baseL && baseL === baseR) {
            setMode('class');
            queueMicrotask(() => fillInputs([stripOneParenthesis(baseL)], []));
            return;
          }
        }
      }
    }

    let core = hasTxSuffix(raw) ? stripTxSuffix(raw) : raw;

    // 3-B: {A,B,C},nN
    if (core.startsWith('{')) {
      const closeIdx = findMatchingBracket(core, 0);
      if (closeIdx > 0) {
        const after = core.slice(closeIdx + 1).trim();
        if (after.startsWith(',')) {
          const nPart = after.slice(1).trim();
          if (isNFormat(nPart)) {
            const inner = core.slice(1, closeIdx).trim();
            const items = splitTopLevel(inner, ',').map((s) => stripParentheses(s.trim())).filter(Boolean);
            if (items.length === 3) {
              setMode('3', 'B');
              queueMicrotask(() => fillInputs([items[0], items[1], items[2]], [extractNum(nPart)]));
              return;
            }
          }
        }
      }
    }

    // 3-A: {A,nN,B,nN,C}
    if (core.startsWith('{') && core.endsWith('}')) {
      const inner = core.slice(1, -1).trim();
      const parts = splitTopLevel(inner, ',').map((s) => s.trim());
      if (parts.length === 5 && isNFormat(parts[1]) && isNFormat(parts[3])) {
        setMode('3', 'A');
        queueMicrotask(() => fillInputs([stripParentheses(parts[0]), stripParentheses(parts[2]), stripParentheses(parts[4])], [extractNum(parts[1])]));
        return;
      }
    }

    // 1つ / 2つ
    const parts = splitTopLevel(core, ',').map((s) => s.trim());
    if (parts.length === 1) {
      setMode('1');
      queueMicrotask(() => fillInputs([stripParentheses(parts[0])], []));
    } else if (parts.length === 3 && isNFormat(parts[1])) {
      // Mode 2: A,nN,B
      setMode('2');
      queueMicrotask(() => fillInputs([stripParentheses(parts[0]), stripParentheses(parts[2])], [extractNum(parts[1])]));
    } else {
      showToast(`解析できない形式です: ${formula}`, 'error', 2600);
    }
  }

  function setMode(m, subM) {
    state.mode = m;
    const modeRadio = document.querySelector(`input[name="mode"][value="${m}"]`);
    if (modeRadio) modeRadio.checked = true;

    if (subM) {
      state.mode3Type = subM;
      const sub = document.querySelector(`input[name="mode3type"][value="${subM}"]`);
      if (sub) sub.checked = true;
    }
    renderInputs();
  }

  function fillInputs(wordArr, numArr) {
    const wInputs = document.querySelectorAll('.inp-word');
    const nInputs = document.querySelectorAll('.inp-num');

    wordArr.forEach((val, i) => { if (wInputs[i]) wInputs[i].value = val; });
    numArr.forEach((val, i) => { if (nInputs[i]) nInputs[i].value = val; });
  }

  // -------------------------
  // Toolbar actions
  // -------------------------
  function editSelectedToInput() {
    const selected = state.mixItems.find((i) => i.selected);
    if (!selected) {
      showToast('選択中の項目がありません', 'warn', 2000);
      return;
    }
    decomposeToInput(selected.text);
  }

  // -------------------------
  // localStorage（デバウンス）
  // -------------------------
  let _saveTimer = null;

  function saveToStorage() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.mixItems));
      } catch (e) {
        console.warn('Failed to save storage', e);
      }
    }, 150);
  }

  function loadFromStorage() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    try {
      state.mixItems = JSON.parse(saved) || [];
    } catch (e) {
      console.error('Failed to load storage', e);
      state.mixItems = [];
    }
  }

  // -------------------------
  // Mix 操作
  // -------------------------
  function addToMix(text, opts = {}) {
    const { silentDuplicate = false } = opts;
    const normalized = normalizeFormulaText(text);
    if (!normalized) return false;

    const exists = state.mixItems.some((i) => normalizeFormulaText(i.text) === normalized);
    if (exists) {
      if (!silentDuplicate) showToast('重複式のため追加しませんでした', 'warn', 1800);
      return false;
    }

    state.mixItems.push({ id: newId(), text: normalized, selected: true });
    renderMix();
    saveToStorage();
    return true;
  }

  function moveItem(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    const [moved] = state.mixItems.splice(fromIndex, 1);
    state.mixItems.splice(toIndex, 0, moved);
    renderMix();
    saveToStorage();
  }

  function clearMix() {
    if (state.mixItems.length === 0) return;
    if (!confirm('Mixリストをすべて削除しますか？')) return;
    state.mixItems = [];
    renderMix();
    saveToStorage();
    showToast('Mixをクリアしました', 'warn', 1400);
  }

  // -------------------------
  // init
  // -------------------------
  function init() {
    bindMixDelegates();
    loadFromStorage();
    renderInputs();
    renderMix();

    modeRadios.forEach((r) => r.addEventListener('change', (e) => {
      state.mode = e.target.value;
      renderInputs();
    }));

    mode3Radios.forEach((r) => r.addEventListener('change', (e) => {
      state.mode3Type = e.target.value;
      renderInputs();
    }));

    btnGenerate?.addEventListener('click', generateFormula);
    btnCreateFinal?.addEventListener('click', createFinalString);
    btnDecomposeMix?.addEventListener('click', decomposeToMix);
    btnCopy?.addEventListener('click', copyOutput);
    btnEditSelected?.addEventListener('click', editSelectedToInput);
    btnClearMix?.addEventListener('click', clearMix);
    btnToggleAll?.addEventListener('click', toggleAllSelection);
    btnSortLength?.addEventListener('click', sortMixByLength);

    updateMixToolbarButtons();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
