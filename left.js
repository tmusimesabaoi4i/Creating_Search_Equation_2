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
  const state = {
    mode: '1',
    mode3Type: 'A',
    sortLenDesc: true, // true: 長い→短い, false: 短い→長い
    mixItems: [] // { id, text, selected }
  };

  // -------------------------
  // DOM
  // -------------------------
  const inputContainer = document.getElementById('input-container');
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

    const createWordInput = (placeholder) =>
      `<input type="text" class="inp-word" placeholder="${placeholder}" />`;

    const createNumInput = (placeholder = 'n', value = '1') =>
      `<input type="number" class="inp-num" placeholder="${placeholder}" value="${value}" min="0" />`;

    let html = '';

    if (state.mode === '1') {
      html += `<div class="input-row">${createWordInput('単語1')}</div>`;
    } else if (state.mode === '2') {
      html += `<div class="input-row">${createWordInput('単語1')}</div>`;
      html += `<div class="input-row">n: ${createNumInput('n', '1')}</div>`;
      html += `<div class="input-row">${createWordInput('単語2')}</div>`;
    } else if (state.mode === '3') {
      if (state.mode3Type === 'A') {
        html += `<div class="input-row">直列 {</div>`;
        html += `<div class="input-row" style="padding-left:10px;">${createWordInput('単語A')}</div>`;
        html += `<div class="input-row" style="padding-left:10px;">n: ${createNumInput('n', '1')}</div>`;
        html += `<div class="input-row" style="padding-left:10px;">${createWordInput('単語B')}</div>`;
        html += `<div class="input-row" style="padding-left:10px;">${createWordInput('単語C')}</div>`;
        html += `<div class="input-row">}/TX</div>`;
      } else if (state.mode3Type === 'B') {
        html += `<div class="input-row">集合 {</div>`;
        html += `<div class="input-row" style="padding-left:10px;">${createWordInput('単語A')}</div>`;
        html += `<div class="input-row" style="padding-left:10px;">${createWordInput('単語B')}</div>`;
        html += `<div class="input-row" style="padding-left:10px;">${createWordInput('単語C')}</div>`;
        html += `<div class="input-row">}, n: ${createNumInput('n', '1')} /TX</div>`;
      } else {
        html += `<div class="input-row">並列 [</div>`;
        html += `<div class="input-row" style="padding-left:10px;">左: ${createWordInput('単語A')} /TX</div>`;
        html += `<div class="input-row" style="padding-left:10px;">右: ${createWordInput('単語B')}, n: ${createNumInput('n', '1')}, ${createWordInput('単語C')} /TX</div>`;
        html += `<div class="input-row">]</div>`;
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
      b.className = 'btn-sm mix-action';
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

    mixListEl.addEventListener('change', (e) => {
      const chk = e.target.closest('input.mix-select');
      if (!chk || !mixListEl.contains(chk)) return;
      const idx = Number(chk.dataset.index);
      if (!Number.isFinite(idx) || !state.mixItems[idx]) return;
      state.mixItems[idx].selected = chk.checked;
      saveToStorage();
      updateToggleAllButton();
    });

    mixListEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button.mix-action');
      if (btn && mixListEl.contains(btn)) {
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
      if (span && mixListEl.contains(span)) {
        const idx = Number(span.dataset.index);
        if (!Number.isFinite(idx) || !state.mixItems[idx]) return;
        decomposeToInput(state.mixItems[idx].text);
      }
    });

    mixListEl.addEventListener('dragstart', (e) => {
      const li = e.target.closest('li.mix-item');
      if (!li || !mixListEl.contains(li)) return;
      const idx = Number(li.dataset.index);
      if (!Number.isFinite(idx)) return;
      draggingIndex = idx;
      li.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', String(idx));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });

    mixListEl.addEventListener('dragend', (e) => {
      const li = e.target.closest('li.mix-item');
      if (li) li.classList.remove('dragging');
      draggingIndex = null;
    });

    mixListEl.addEventListener('dragover', (e) => {
      const li = e.target.closest('li.mix-item');
      if (!li || !mixListEl.contains(li)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });

    mixListEl.addEventListener('drop', (e) => {
      const li = e.target.closest('li.mix-item');
      if (!li || !mixListEl.contains(li)) return;
      e.preventDefault();
      const to = Number(li.dataset.index);
      const from = draggingIndex ?? Number(e.dataTransfer?.getData('text/plain'));
      if (Number.isFinite(from) && Number.isFinite(to)) moveItem(from, to);
    });
  }

  function renderMix() {
    if (!mixListEl) return;

    _renderVer += 1;
    const ver = _renderVer;

    mixListEl.textContent = '';
    updateMixToolbarButtons();

    const total = state.mixItems.length;
    if (total === 0) return;

    const chunkSize = total > 800 ? 120 : 260;
    let i = 0;

    const appendChunk = () => {
      if (ver !== _renderVer) return;

      const frag = document.createDocumentFragment();
      const end = Math.min(total, i + chunkSize);
      for (; i < end; i++) frag.appendChild(buildMixItemLi(state.mixItems[i], i));
      mixListEl.appendChild(frag);

      if (i < total) requestAnimationFrame(appendChunk);
      else updateMixToolbarButtons();
    };

    if (total > 300) requestAnimationFrame(appendChunk);
    else appendChunk();
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
      if (!lr) return;
      const left = lr[0].trim();
      const right = lr[1].trim();
      if (!hasTxSuffix(left) || !hasTxSuffix(right)) return;

      const wordA = stripParentheses(stripTxSuffix(left));
      const rightCore = stripTxSuffix(right);
      const parts = splitTopLevel(rightCore, ',').map((s) => s.trim());
      
      if (parts.length === 3 && isNFormat(parts[1])) {
        setMode('3', 'C');
        queueMicrotask(() => fillInputs([wordA, stripParentheses(parts[0]), stripParentheses(parts[2])], [extractNum(parts[1])]));
        return;
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
