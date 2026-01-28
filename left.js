/* =========================================================
   left.js - 式作成ツール（left）
   要望対応:
   1) Copy等の通知: toast
   2) HTML/CSS/JS 分割
   3) Mix -> Input 逆生成（Editボタン + クリックで展開）
   4) 3つ直列(A,n,B,n,C) の n を2つ入力可能 (n1, n2)
   4.5) Input->Mix: 半角化 → '+'分割→長い順→英数字は全角/半角の2版→再ソート&重複排除→'+'結合
   5) Input->Mix: 単語内に'+'があれば全体を()で囲む
   6) Mix: ドラッグで並び替え可
   ========================================================= */

(() => {
  'use strict';

  // -------------------------
  // 状態管理
  // -------------------------
  const state = {
    mode: '1',
    mode3Type: 'A',
    mixItems: [] // { id, text, selected }
  };

  // -------------------------
  // DOM
  // -------------------------
  const inputContainer = document.getElementById('input-container');
  const modeRadios = document.getElementsByName('mode');
  const mode3Options = document.getElementById('mode3-options');
  const mode3Radios = document.getElementsByName('mode3type');
  const mixListEl = document.getElementById('mix-list');
  const finalOutput = document.getElementById('final-output');

  const btnGenerate = document.getElementById('btn-generate');
  const btnCreateFinal = document.getElementById('btn-create-final');
  const btnDecomposeMix = document.getElementById('btn-decompose-mix');
  const btnCopy = document.getElementById('btn-copy');
  const btnEditSelected = document.getElementById('btn-edit-selected');
  const btnClearMix = document.getElementById('btn-clear-mix');

  // -------------------------
  // Toast
  // -------------------------
  const toastContainer = document.getElementById('toast-container');

  function showToast(message, type = 'info', ms = 2000) {
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
  // 文字列ユーティリティ
  // -------------------------
  function toHalfWidth(str) {
    // 全角英数字記号 → 半角
    return str
      .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ');
  }

  function toFullWidth(str) {
    // 半角英数字記号 → 全角
    return str
      .replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xFEE0))
      .replace(/ /g, '　');
  }

  function isAlphaNum(str) {
    return /^[0-9A-Za-z]+$/.test(str);
  }

  /**
   * 要望4.5 + 要望5: Input->Mix用に単語を正規化する
   * - 半角化
   * - '+'があれば分割→長い順
   * - 英数字だけのトークンは「全角版」「半角版」を追加
   * - 再ソート(長い順)→重複排除
   * - '+'結合
   * - もともと'+'を含んでいた場合は全体を()で囲む
   */
  function normalizeWordForMix(rawWord) {
    const half = toHalfWidth(String(rawWord ?? '')).trim();
    if (!half) return '';

    const hadPlus = half.includes('+');
    if (!hadPlus) return half;

    const baseTokens = half
      .split('+')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // 長い順（同長は辞書順）
    baseTokens.sort((a, b) => (b.length - a.length) || a.localeCompare(b));

    // 英数字なら全角/半角の2版を追加
    let expanded = [];
    for (const t of baseTokens) {
      if (isAlphaNum(t)) {
        expanded.push(t);
        expanded.push(toFullWidth(t));
      } else {
        expanded.push(t);
      }
    }

    expanded.sort((a, b) => (b.length - a.length) || a.localeCompare(b));

    // 重複排除（ソート順を保持）
    const seen = new Set();
    const deduped = [];
    for (const t of expanded) {
      if (!seen.has(t)) {
        seen.add(t);
        deduped.push(t);
      }
    }

    const joined = deduped.join('+');
    return `(${joined})`;
  }

  // -------------------------
  // View: 入力欄描画
  // -------------------------
  function renderInputs() {
    inputContainer.innerHTML = '';
    mode3Options.style.display = (state.mode === '3') ? 'block' : 'none';

    const createWordInput = (placeholder) =>
      `<input type="text" class="inp-word" placeholder="${placeholder}" />`;

    const createNumInput = (placeholder = 'n', value = '1') =>
      `<input type="number" class="inp-num" placeholder="${placeholder}" value="${value}" min="0" />`;

    let html = '';

    if (state.mode === '1') {
      html += `<div class="input-row">${createWordInput('単語1')}</div>`;
    } else if (state.mode === '2') {
      html += `<div class="input-row">${createWordInput('単語1')}</div>`;
      html += `<div class="input-row">数値n: ${createNumInput('n', '1')}</div>`;
      html += `<div class="input-row">${createWordInput('単語2')}</div>`;
    } else if (state.mode === '3') {
      if (state.mode3Type === 'A') {
        // (A,n1,B,n2,C)/TX
        html += `<div class="input-row">${createWordInput('単語1')}</div>`;
        html += `<div class="input-row">数値n1: ${createNumInput('n1', '1')}</div>`;
        html += `<div class="input-row">${createWordInput('単語2')}</div>`;
        html += `<div class="input-row">数値n2: ${createNumInput('n2', '1')}</div>`;
        html += `<div class="input-row">${createWordInput('単語3')}</div>`;
      } else {
        // {A,B,C},n/TX
        html += `<div class="input-row">集合 {</div>`;
        html += `<div class="input-row" style="padding-left:10px;">${createWordInput('単語1')}</div>`;
        html += `<div class="input-row" style="padding-left:10px;">${createWordInput('単語2')}</div>`;
        html += `<div class="input-row" style="padding-left:10px;">${createWordInput('単語3')}</div>`;
        html += `<div class="input-row">}, 数値n: ${createNumInput('n', '1')}</div>`;
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

    // validation
    if (rawWords.some((w) => w === '')) {
      showToast('単語を入力してください', 'error', 2400);
      return;
    }

    // 要望4.5 + 5
    const words = rawWords.map(normalizeWordForMix);

    let result = '';

    if (state.mode === '1') {
      result = `${words[0]}/TX`;
    } else if (state.mode === '2') {
      result = `${words[0]},${nums[0] || '1'},${words[1]}/TX`;
    } else if (state.mode === '3') {
      if (state.mode3Type === 'A') {
        const n1 = nums[0] || '1';
        const n2 = nums[1] || '1';
        result = `${words[0]},${n1},${words[1]},${n2},${words[2]}/TX`;
      } else {
        result = `{${words[0]},${words[1]},${words[2]}},${nums[0] || '1'}/TX`;
      }
    }

    addToMix(result);
    showToast('Mixに追加しました', 'success', 1600);
  }

  // -------------------------
  // Mix管理 + 並び替え
  // -------------------------
  function newId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return String(Date.now()) + '_' + String(Math.random()).slice(2);
  }

  function addToMix(text) {
    state.mixItems.push({ id: newId(), text, selected: true });
    renderMix();
  }

  function moveItem(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= state.mixItems.length) return;
    if (toIndex < 0 || toIndex >= state.mixItems.length) return;

    const [moved] = state.mixItems.splice(fromIndex, 1);
    state.mixItems.splice(toIndex, 0, moved);
    renderMix();
  }

  let draggingIndex = null;

  function renderMix() {
    mixListEl.innerHTML = '';

    state.mixItems.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'mix-item';
      li.draggable = true;
      li.dataset.index = String(index);

      li.addEventListener('dragstart', (e) => {
        draggingIndex = index;
        li.classList.add('dragging');
        e.dataTransfer?.setData('text/plain', String(index));
        e.dataTransfer && (e.dataTransfer.effectAllowed = 'move');
      });

      li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        draggingIndex = null;
      });

      li.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer && (e.dataTransfer.dropEffect = 'move');
      });

      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = draggingIndex ?? Number(e.dataTransfer?.getData('text/plain'));
        const to = index;
        if (Number.isFinite(from) && Number.isFinite(to)) {
          moveItem(from, to);
        }
      });

      // drag handle
      const handle = document.createElement('div');
      handle.className = 'drag-handle';
      handle.title = 'ドラッグで並び替え';
      handle.textContent = '☰';

      // checkbox
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!item.selected;
      chk.addEventListener('change', () => {
        item.selected = chk.checked;
      });

      // text (クリックでInputへ)
      const span = document.createElement('span');
      span.textContent = item.text;
      span.title = 'クリックで入力欄に逆展開(編集)';
      span.addEventListener('click', () => {
        decomposeToInput(item.text);
        showToast('Inputへ展開しました', 'info', 1400);
      });

      // actions
      const actions = document.createElement('div');
      actions.className = 'mix-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn-sm';
      editBtn.type = 'button';
      editBtn.textContent = 'Edit';
      editBtn.title = 'Inputへ展開';
      editBtn.addEventListener('click', () => {
        decomposeToInput(item.text);
        showToast('Inputへ展開しました', 'info', 1400);
      });

      const upBtn = document.createElement('button');
      upBtn.className = 'btn-sm';
      upBtn.type = 'button';
      upBtn.textContent = '↑';
      upBtn.title = '上へ';
      upBtn.addEventListener('click', () => moveItem(index, Math.max(0, index - 1)));

      const downBtn = document.createElement('button');
      downBtn.className = 'btn-sm';
      downBtn.type = 'button';
      downBtn.textContent = '↓';
      downBtn.title = '下へ';
      downBtn.addEventListener('click', () => moveItem(index, Math.min(state.mixItems.length - 1, index + 1)));

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-sm';
      delBtn.type = 'button';
      delBtn.textContent = '×';
      delBtn.title = '削除';
      delBtn.addEventListener('click', () => {
        state.mixItems.splice(index, 1);
        renderMix();
        showToast('削除しました', 'warn', 1400);
      });

      actions.append(editBtn, upBtn, downBtn, delBtn);
      li.append(handle, chk, span, actions);
      mixListEl.appendChild(li);
    });
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
    finalOutput.value = selected.join('*');
    showToast('Outputに反映しました', 'success', 1400);
  }

  async function copyOutput() {
    const text = finalOutput.value;
    if (!text) {
      showToast('コピーする内容がありません', 'warn', 1800);
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // fallback
        finalOutput.focus();
        finalOutput.select();
        document.execCommand('copy');
      }
      showToast('コピーしました', 'success', 1600);
    } catch (e) {
      showToast('コピーに失敗しました（ブラウザ権限を確認してください）', 'error', 2600);
    }
  }

  // -------------------------
  // Output -> Mix（逆変換）
  // -------------------------
  function decomposeToMix() {
    const raw = finalOutput.value.trim();
    if (!raw) {
      showToast('Outputが空です', 'warn', 1800);
      return;
    }

    const parts = raw.split('*').map((s) => s.trim()).filter(Boolean);
    state.mixItems = [];
    for (const p of parts) addToMix(p);

    showToast('Mixへ分解しました', 'success', 1400);
  }

  // -------------------------
  // Mix Item -> Input（完全逆変換）
  // -------------------------
  function decomposeToInput(formula) {
    let core = String(formula ?? '').trim();
    if (!core) return;

    // 末尾 /TX の除去
    core = core.replace(/\/TX$/, '');

    // 3-B: {A,B,C},n
    const match3B = core.match(/^\{(.+),(.+),(.+)\},(\d+)$/);
    if (match3B) {
      setMode('3', 'B');
      queueMicrotask(() => fillInputs([match3B[1], match3B[2], match3B[3]], [match3B[4]]));
      return;
    }

    const parts = core.split(',');

    if (parts.length === 1) {
      setMode('1');
      queueMicrotask(() => fillInputs([parts[0]], []));
      return;
    }

    if (parts.length === 3) {
      setMode('2');
      queueMicrotask(() => fillInputs([parts[0], parts[2]], [parts[1]]));
      return;
    }

    if (parts.length === 5) {
      // 3-A: A,n1,B,n2,C
      setMode('3', 'A');
      queueMicrotask(() => fillInputs([parts[0], parts[2], parts[4]], [parts[1], parts[3]]));
      return;
    }

    showToast(`解析できない形式です: ${formula}`, 'error', 2800);
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
    showToast('Inputへ展開しました', 'info', 1400);
  }

  function clearMix() {
    if (state.mixItems.length === 0) {
      showToast('Mixは空です', 'info', 1400);
      return;
    }
    state.mixItems = [];
    renderMix();
    showToast('Mixをクリアしました', 'warn', 1400);
  }

  // -------------------------
  // init
  // -------------------------
  function init() {
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

    btnGenerate.addEventListener('click', generateFormula);
    btnCreateFinal.addEventListener('click', createFinalString);
    btnDecomposeMix.addEventListener('click', decomposeToMix);
    btnCopy.addEventListener('click', copyOutput);
    btnEditSelected.addEventListener('click', editSelectedToInput);
    btnClearMix.addEventListener('click', clearMix);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
