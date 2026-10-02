'use strict';

/**
 * 标定页“迟到响应”回归测试（Node ≥ 18，无第三方依赖）。
 *
 * 运行：node test_calib_stale.js
 *
 * 背景：标定请求在途期间，用户清空实测零值、或修改样本/通道 ID 后又改回
 * 原值，旧的“指纹比对”会把迟到的 non_unique 响应当作当前响应接受，旧补测
 * 建议重新出现（指纹不含实测待填状态，且改回原值后会撞回提交时的值）。
 * 修复后改用单调递增的输入世代号：通道 ID、样本驱动、实测值或待填状态一经
 * 改变，旧建议与在途请求即失效，恢复原值也不能重新接纳旧响应。
 *
 * 方法：用 vm 把 static/app.js 原样装进受控环境——
 *   - 假 DOM：按选择器缓存的元素桩，支持监听器派发，足以跑通标定流程；
 *   - 可控延迟 fetch：每次调用挂起为 pending 请求，由测试决定何时、以
 *     成功 / HTTP 错误 / 网络错误放行，精确复现“请求在途时输入又变”的竞态。
 *
 * 覆盖：清空实测零值、编辑样本/通道 ID 后恢复原值、样本增删、按建议追加、
 * 载入/生成示例、丢弃后重算、按钮收尾（过期请求不得改动新请求的按钮与结果）、
 * 过期成功/失败响应不得恢复建议或覆盖当前提示、未填完整仍拒绝提交。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* ---------------- 假 DOM ---------------- */

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this._value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.title = '';
    this.style = {};
    this.dataset = {};
    this.listeners = Object.create(null);
    this.classes = new Set();
  }

  // 与真实 DOM 一致：value 赋值一律按字符串存储（reset-sample 会赋数值）
  get value() { return this._value; }
  set value(v) { this._value = String(v); }

  get classList() { return { contains: (c) => this.classes.has(c) }; }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event) { for (const fn of this.listeners[type] || []) fn(event); }

  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  scrollIntoView() {}
}

// 与 index.html 中各输入框的初始值一致
const PRESET_VALUES = {
  '#target-r': '600', '#target-g': '420', '#target-b': '180', '#tolerance': '12',
  '#robust-delta': '80',
  '#path-target-r': '600', '#path-target-g': '420', '#path-target-b': '180',
  '#path-steps': '3', '#path-delta': '40',
};

const elements = new Map();
const documentStub = {
  querySelector(sel) {
    if (!elements.has(sel)) {
      const el = new FakeElement();
      if (Object.hasOwn(PRESET_VALUES, sel)) el.value = PRESET_VALUES[sel];
      elements.set(sel, el);
    }
    return elements.get(sel);
  },
  querySelectorAll() { return []; },
};
const $el = (sel) => documentStub.querySelector(sel);

/* ---------------- 可控延迟 fetch ---------------- */

// 每次 fetch 挂起为一个 pending 请求，测试自行决定何时、以何种结果放行
const pending = []; // {url, body, resolve, reject}
function fetchStub(url, opts) {
  return new Promise((resolve, reject) => {
    pending.push({ url, body: JSON.parse(opts.body), resolve, reject });
  });
}
const respondOk = (req, data) => req.resolve({ ok: true, json: async () => data });
const respondHttp = (req, status, data) =>
  req.resolve({ ok: false, status, json: async () => data });
const respondNetError = (req, message) => req.reject(new Error(message));

/* ---------------- 装载 app.js ---------------- */

const ctx = vm.createContext({ document: documentStub, fetch: fetchStub });
vm.runInContext(
  fs.readFileSync(path.join(__dirname, 'static', 'app.js'), 'utf8'),
  ctx,
  { filename: 'static/app.js' },
);
// 与页面中第二个 <script> 同理：同一上下文里可读写 app.js 的顶层绑定
const run = (code) => vm.runInContext(code, ctx);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`[OK] ${name}`); };
const calibBtn = () => $el('#calib-btn');
const banner = () => $el('#error-banner');

/* ---------------- 驱动 UI 的辅助函数 ---------------- */

// 提交一次标定；返回 onCalibrate 的 Promise 与本次发出的请求（校验拒绝时为 null）
function submitCalib() {
  const before = pending.length;
  const p = run('onCalibrate()');
  return { p, req: pending.length > before ? pending[pending.length - 1] : null };
}

// 构造与 renderCalibTable 行结构一致的假样本行（初值取自当前状态）
function fakeSampleRow(si) {
  const smp = run(`calibSamples[${si}]`);
  const ids = [...run('channels.map((c) => c.id)')];
  const blank = smp.measuredBlank || [false, false, false];
  const tr = new FakeElement('tr');
  tr.dataset = { s: String(si) };
  const driveInputs = ids.map((id) => {
    const el = new FakeElement('input');
    el.dataset = { id };
    el.value = String(smp.drives[id] ?? 0);
    el.closest = () => tr;
    return el;
  });
  const mInputs = [0, 1, 2].map((c) => {
    const el = new FakeElement('input');
    el.dataset = { c: String(c) };
    el.value = blank[c] ? '' : String(smp.measured[c]);
    el.closest = () => tr;
    return el;
  });
  tr.querySelectorAll = (sel) =>
    sel === '.cd-drive' ? driveInputs : sel === '.cd-m' ? mInputs : [];
  return { tr, driveInputs, mInputs };
}

// 用户编辑样本行：mutate 修改假输入并返回事件目标，随后向 #sample-tbody 派发 input
function userEditsSampleRow(si, mutate) {
  const row = fakeSampleRow(si);
  const target = mutate(row) || row.mInputs[0];
  $el('#sample-tbody').dispatch('input', { target });
}

// 用户删除第 si 组样本
function userDeletesSampleRow(si) {
  const btn = new FakeElement('button');
  btn.classes.add('sample-del');
  const tr = new FakeElement('tr');
  tr.dataset = { s: String(si) };
  btn.closest = () => tr;
  $el('#sample-tbody').dispatch('click', { target: btn });
}

// 用户把第 i 路通道 ID 改为 newId（走 #channel-tbody 的 input 事件）
function userRenamesChannel(i, newId) {
  const ch = run(`channels[${i}]`);
  const tr = new FakeElement('tr');
  tr.dataset = { i: String(i) };
  const mk = (cls, val) => {
    const el = new FakeElement('input');
    el.classes.add(cls);
    el.value = String(val);
    el.closest = () => tr;
    return el;
  };
  const fields = {
    '.f-id': mk('f-id', ch.id),
    '.f-r': mk('f-r', ch.r),
    '.f-g': mk('f-g', ch.g),
    '.f-b': mk('f-b', ch.b),
    '.f-p': mk('f-p', ch.power_mw),
  };
  tr.querySelector = (sel) => fields[sel] || null;
  fields['.f-id'].value = newId;
  $el('#channel-tbody').dispatch('input', { target: fields['.f-id'] });
}

/* ---------------- 服务端响应（可控内容） ---------------- */

// non_unique：按当前通道构造一次可执行补测建议（末路单亮 255，两组见证）
function nonUniquePayload(tag) {
  const ids = [...run('channels.map((c) => c.id)')];
  const n = ids.length;
  const matrix = (b) => ids.map((id, i) => ({
    id, r: 100 + i, g: 200 + i, b: i === n - 1 ? b : 300 + i,
  }));
  return {
    status: 'non_unique',
    channels: [],
    suggestion: {
      channel_id: ids[n - 1],
      drives: ids.map((_, i) => (i === n - 1 ? 255 : 0)),
      witnesses: [
        { matrix: matrix(1), predicted: [100 + n - 1, 200 + n - 1, 1] },
        { matrix: matrix(2), predicted: [100 + n - 1, 200 + n - 1, 2] },
      ],
    },
    message: `标定不唯一（${tag}）`,
  };
}

function uniquePayload() {
  const ids = [...run('channels.map((c) => c.id)')];
  return {
    status: 'unique',
    channels: ids.map((id, i) => ({ id, r: 500 + i, g: 600 + i, b: 700 + i })),
    suggestion: null,
    message: '标定唯一',
  };
}

/* ---------------- 场景 ---------------- */

async function main() {
  // 初始：4 路通道（R/G/B/W）；第 4 组样本实测全为 0（供“清空零值”场景）
  run(`calibSamples = [
    { drives: { R: 255, G: 0, B: 0, W: 0 }, measured: [1000, 120, 40], measuredBlank: [false, false, false] },
    { drives: { R: 0, G: 255, B: 0, W: 0 }, measured: [160, 1000, 90], measuredBlank: [false, false, false] },
    { drives: { R: 0, G: 0, B: 255, W: 0 }, measured: [60, 80, 1000], measuredBlank: [false, false, false] },
    { drives: { R: 0, G: 0, B: 0, W: 0 }, measured: [0, 0, 0], measuredBlank: [false, false, false] },
  ]`);

  // ---- 1) 在途期间清空实测零值 → 迟到 non_unique 被丢弃，按钮恢复可用 ----
  {
    const { p, req } = submitCalib();
    assert.ok(req, '合法输入应发出标定请求');
    // POST /api/calibrate 字段保持不变
    assert.equal(req.url, '/api/calibrate');
    assert.deepEqual(req.body.channels.map((c) => c.id), ['R', 'G', 'B', 'W']);
    assert.deepEqual(req.body.samples[3], { drives: [0, 0, 0, 0], measured: [0, 0, 0] });
    assert.equal(calibBtn().disabled, true);
    assert.equal(calibBtn().textContent, '反求中…');

    // 用户把样本 #4 的实测 R（值为 0）清空：数值仍是 0，仅待填状态改变
    userEditsSampleRow(3, (row) => { row.mInputs[0].value = ''; return row.mInputs[0]; });
    assert.equal(run('calibSamples[3].measured[0]'), 0);
    assert.equal(run('calibSamples[3].measuredBlank[0]'), true);

    respondOk(req, nonUniquePayload('清空零值'));
    await p;
    assert.equal(run('calibSuggestion'), null, '迟到响应不得恢复旧建议');
    assert.equal($el('#calib-suggestion').hidden, true);
    assert.equal($el('#calib-result').hidden, true);
    assert.equal(calibBtn().disabled, false, '无新请求时按钮应恢复可用');
    assert.equal(calibBtn().textContent, '反求满档读数');
    ok('清空实测零值：在途 non_unique 响应被丢弃，按钮恢复可用');
  }

  // ---- 1b) 实测留空待填：拒绝提交且不发出请求 ----
  {
    const before = pending.length;
    await run('onCalibrate()');
    assert.equal(pending.length, before, '未填完整不得发出请求');
    assert.match(banner().className, /error/);
    assert.match(banner().innerHTML, /未填完整/);
    ok('实测留空待填：仍拒绝提交（不发出请求）');

    // 手工填回实测值，恢复为合法输入
    userEditsSampleRow(3, (row) => { row.mInputs[0].value = '0'; return row.mInputs[0]; });
    assert.equal(run('calibSamples[3].measuredBlank[0]'), false);
  }

  // ---- 2) 编辑样本后又改回原值：迟到响应仍被丢弃 ----
  {
    const { p, req } = submitCalib();
    assert.ok(req);
    // 样本 #1 的 R 驱动 255 → 200 → 255（恢复原值）
    userEditsSampleRow(0, (row) => { row.driveInputs[0].value = '200'; return row.driveInputs[0]; });
    userEditsSampleRow(0, (row) => { row.driveInputs[0].value = '255'; return row.driveInputs[0]; });
    assert.equal(run('calibSamples[0].drives.R'), 255, '驱动级已改回原值');

    respondOk(req, nonUniquePayload('编辑后恢复'));
    await p;
    assert.equal(run('calibSuggestion'), null, '改回原值也不能重新接纳旧响应');
    assert.equal($el('#calib-suggestion').hidden, true);
    assert.equal(calibBtn().disabled, false);
    ok('编辑样本后恢复原值：迟到响应仍被丢弃');
  }

  // ---- 2b) 通道 ID 改名后又改回：在途请求同样失效 ----
  {
    const { p, req } = submitCalib();
    assert.ok(req);
    userRenamesChannel(0, 'R2');
    assert.equal(run('channels[0].id'), 'R2');
    userRenamesChannel(0, 'R');
    assert.equal(run('channels[0].id'), 'R');

    respondOk(req, nonUniquePayload('改名后恢复'));
    await p;
    assert.equal(run('calibSuggestion'), null);
    assert.equal($el('#calib-suggestion').hidden, true);
    assert.equal(calibBtn().disabled, false);
    ok('通道 ID 改名后恢复：在途请求失效，迟到响应被丢弃');
  }

  // ---- 3) 丢弃后重算：合法输入可重新标定，新 non_unique 正常展示 ----
  {
    const { p, req } = submitCalib();
    assert.ok(req, '合法输入仍可重新标定');
    const payload = nonUniquePayload('重算');
    respondOk(req, payload);
    await p;
    assert.equal(run('calibSuggestion'), payload.suggestion, '新建议应正常展示');
    assert.equal($el('#calib-result').hidden, false);
    assert.equal($el('#calib-suggestion').hidden, false);
    assert.match($el('#calib-status').className, /s-non_unique/);
    assert.equal(calibBtn().disabled, false);
    ok('丢弃后重算：新 non_unique 补测建议正常展示');
  }

  // ---- 3b) 按建议追加：样本 +1 且实测留空，建议失效，未填完整拒绝提交 ----
  {
    const n0 = run('calibSamples.length');
    $el('#add-suggestion-btn').dispatch('click');
    assert.equal(run('calibSamples.length'), n0 + 1);
    assert.deepEqual(
      [...run('calibSamples[calibSamples.length - 1].measuredBlank')],
      [true, true, true],
      '追加行实测三格留空待填',
    );
    assert.equal(run('calibSuggestion'), null, '追加后旧建议随之失效');
    assert.equal($el('#calib-suggestion').hidden, true);

    const before = pending.length;
    await run('onCalibrate()');
    assert.equal(pending.length, before, '追加行未填实测，拒绝提交');
    assert.match(banner().innerHTML, /未填完整/);
    ok('按建议追加：实测留空待填，未填完整仍拒绝提交');

    // 删除追加的待填行，恢复合法输入
    userDeletesSampleRow(run('calibSamples.length') - 1);
    assert.equal(run('calibSamples.length'), n0);
  }

  // ---- 4) 样本增删、载入/生成示例同样使在途请求失效 ----
  {
    const stale = async (name, act) => {
      const { p, req } = submitCalib();
      assert.ok(req, `${name}：提交应发出请求`);
      act();
      respondOk(req, nonUniquePayload(name));
      await p;
      assert.equal(run('calibSuggestion'), null, `${name}：迟到响应不得恢复旧建议`);
      assert.equal($el('#calib-suggestion').hidden, true);
      assert.equal(calibBtn().disabled, false, `${name}：按钮恢复可用`);
      ok(`${name}：在途请求失效，迟到响应被丢弃`);
    };

    const n0 = run('calibSamples.length');
    await stale('添加样本', () => {
      $el('#add-sample').dispatch('click');
      assert.equal(run('calibSamples.length'), n0 + 1);
    });
    await stale('删除样本', () => {
      userDeletesSampleRow(0);
      assert.equal(run('calibSamples.length'), n0);
    });
    await stale('载入示例', () => {
      $el('#reset-sample').dispatch('click');
      assert.equal(run('calibSamples.length'), 5);
    });
    await stale('生成示例样本', () => {
      $el('#gen-samples').dispatch('click');
      assert.equal(run('calibSamples.length'), 4);
    });
  }

  // ---- 5) 按钮收尾：新请求在途时，过期请求不得改动按钮与结果 ----
  {
    const first = submitCalib();
    const second = submitCalib(); // 并发在途（绕过禁用按钮直接触发）
    assert.ok(first.req && second.req);
    assert.equal(calibBtn().disabled, true);

    // 旧请求迟到响应：被丢弃，且不得恢复按钮（新请求仍在途）
    respondOk(first.req, nonUniquePayload('旧请求'));
    await first.p;
    assert.equal(run('calibSuggestion'), null);
    assert.equal(calibBtn().disabled, true, '新请求在途，旧请求不得恢复按钮');
    assert.equal(calibBtn().textContent, '反求中…');

    // 新请求返回：正常展示，按钮恢复可用
    const payload = nonUniquePayload('新请求');
    respondOk(second.req, payload);
    await second.p;
    assert.equal(run('calibSuggestion'), payload.suggestion);
    assert.equal(calibBtn().disabled, false);
    assert.equal(calibBtn().textContent, '反求满档读数');
    ok('按钮收尾：过期请求不动新请求的按钮，新请求正常收尾');
  }

  // ---- 5b) 新请求先返回、旧请求后返回：旧响应不得覆盖新结果 ----
  {
    const first = submitCalib();
    const second = submitCalib();
    const payload = nonUniquePayload('新-先回');
    respondOk(second.req, payload);
    await second.p;
    assert.equal(run('calibSuggestion'), payload.suggestion);
    assert.equal(calibBtn().disabled, false);

    // 旧请求更晚返回，甚至带回“唯一”结果：也不得覆盖新建议/写回区
    respondOk(first.req, uniquePayload());
    await first.p;
    assert.equal(run('calibSuggestion'), payload.suggestion, '旧响应不得覆盖新建议');
    assert.equal(run('calibUnique'), null, '旧请求的唯一结果不得展示');
    assert.equal($el('#calib-unique-block').hidden, true);
    assert.equal(calibBtn().disabled, false);
    ok('新请求先返回：旧请求的迟到响应不得覆盖新结果');
  }

  // ---- 6) 过期的 HTTP 失败响应：不得恢复建议、不得覆盖当前提示 ----
  {
    const { p, req } = submitCalib(); // 合法提交，请求在途
    assert.ok(req);
    // 清空实测 → 在途失效；再提交被前端拒绝（校验错误横幅成为当前提示）
    userEditsSampleRow(0, (row) => { row.mInputs[0].value = ''; return row.mInputs[0]; });
    await run('onCalibrate()');
    assert.match(banner().innerHTML, /未填完整/);

    respondHttp(req, 422, { detail: '样本矛盾（迟到的拒绝）' });
    await p;
    assert.match(banner().innerHTML, /未填完整/, '过期 422 不得覆盖当前提示');
    assert.equal(run('calibSuggestion'), null);
    assert.equal(calibBtn().disabled, false, '过期请求收尾后按钮恢复可用');
    ok('过期 HTTP 失败响应：不覆盖当前提示，按钮正常收尾');

    // 填回实测，恢复合法输入
    userEditsSampleRow(0, (row) => { row.mInputs[0].value = '0'; return row.mInputs[0]; });
  }

  // ---- 6b) 过期的网络失败响应：不得弹出错误提示 ----
  {
    const { p, req } = submitCalib();
    assert.ok(req);
    assert.equal(banner().className, 'banner error hidden', '提交时横幅已清空');
    userEditsSampleRow(0, (row) => { row.mInputs[1].value = '777'; return row.mInputs[1]; });

    respondNetError(req, '连接中断（迟到）');
    await p;
    assert.equal(banner().className, 'banner error hidden', '过期网络失败不得弹出错误提示');
    assert.equal(run('calibSuggestion'), null);
    assert.equal(calibBtn().disabled, false);
    ok('过期网络失败响应：不覆盖提示、不恢复建议');
  }

  // ---- 7) 唯一写回规则保持不变：唯一结果展示并可一键写回（保留功率） ----
  {
    const { p, req } = submitCalib();
    assert.ok(req);
    respondOk(req, uniquePayload());
    await p;
    assert.equal(run('calibUnique !== null'), true);
    assert.equal($el('#calib-unique-block').hidden, false);
    assert.equal($el('#calib-suggestion').hidden, true);
    assert.equal($el('#writeback-btn').disabled, false, '通道一致时写回可用');

    $el('#writeback-btn').dispatch('click');
    assert.equal(run('channels[0].r'), 500);
    assert.equal(run('channels[0].g'), 600);
    assert.equal(run('channels[0].b'), 700);
    assert.equal(run('channels[0].power_mw'), 3200, '写回保留原功率');
    assert.match(banner().className, /info/);
    ok('唯一结果写回规则不变：只覆盖满档 RGB、保留原功率');
  }
}

main().then(
  () => console.log(`\n全部通过 ✔（${passed} 项）`),
  (err) => { console.error(err); process.exit(1); },
);
