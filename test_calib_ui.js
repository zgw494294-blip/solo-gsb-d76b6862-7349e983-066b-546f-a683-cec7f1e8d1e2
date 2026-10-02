'use strict';

/**
 * 标定页面“旧补测建议重新出现”的回归测试（Node + jsdom，不依赖浏览器）。
 *
 * 修复目标：标定请求在途期间，只要通道 ID、样本驱动、实测值或待填状态发生
 * 变化（含样本增删、按建议追加、载入/生成示例），旧补测建议与在途标定请求
 * 都必须失效；即使把输入改回原值，迟到的 non_unique 响应也不得重新显示旧
 * 建议。过期响应的成功或失败都不得恢复建议或覆盖当前提示；没有更新的请求
 * 时按钮自动恢复可用，已有新请求时旧请求不得改动新请求的按钮与结果。
 *
 * 实现方式：用 jsdom 加载真实的 static/index.html 与 static/app.js，
 * 把 fetch 换成**可控延迟**的桩——响应何时到达、成功还是失败完全由测试
 * 决定，从而精确复现“迟到响应”。
 *
 * 运行：npm install && node test_calib_ui.js（或 npm run test:ui）
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = __dirname;
const HTML = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT, 'static', 'app.js'), 'utf8');

/* ---------------- 可控延迟 fetch 桩 ----------------
 * fetch 调用后 Promise 挂起，直到测试显式 respondOk / respondErr；
 * 响应到达顺序与请求顺序一致（FIFO）。 */
function makeFetchMock() {
  const calls = []; // 全部调用记录 {url, body}
  const pending = []; // 尚未响应的 {url, body, resolve}
  const fetch = (url, opts = {}) => {
    const call = { url, body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    return new Promise((resolve) => pending.push({ ...call, resolve }));
  };
  const respond = (data, { ok = true, status = 200 } = {}) => {
    assert.ok(pending.length > 0, '没有待响应的在途请求');
    const p = pending.shift();
    p.resolve({ ok, status, json: async () => JSON.parse(JSON.stringify(data)) });
  };
  return {
    fetch,
    calls,
    pending,
    respondOk: (data) => respond(data),
    respondErr: (status, data) => respond(data, { ok: false, status }),
  };
}

/* ---------------- 测试响应桩数据（与页面默认 4 通道 R/G/B/W 对齐） ---------------- */

const NON_UNIQUE = {
  status: 'non_unique',
  channels: [],
  suggestion: {
    channel_id: 'W',
    drives: [0, 0, 0, 255],
    witnesses: [
      {
        matrix: [
          { id: 'R', r: 1000, g: 120, b: 40 },
          { id: 'G', r: 160, g: 1000, b: 90 },
          { id: 'B', r: 60, g: 80, b: 1000 },
          { id: 'W', r: 1, g: 0, b: 0 },
        ],
        predicted: [1, 0, 0],
      },
      {
        matrix: [
          { id: 'R', r: 1000, g: 120, b: 40 },
          { id: 'G', r: 160, g: 1000, b: 90 },
          { id: 'B', r: 60, g: 80, b: 1000 },
          { id: 'W', r: 1, g: 1, b: 1 },
        ],
        predicted: [1, 1, 1],
      },
    ],
  },
  message: '标定不唯一：存在多组合法参数（测试桩）。',
};

const UNIQUE = {
  status: 'unique',
  channels: [
    { id: 'R', r: 1000, g: 120, b: 40 },
    { id: 'G', r: 160, g: 1000, b: 90 },
    { id: 'B', r: 60, g: 80, b: 1000 },
    { id: 'W', r: 820, g: 800, b: 760 },
  ],
  suggestion: null,
  message: '标定唯一（测试桩）。',
};

/* ---------------- 页面启动与 DOM 助手 ---------------- */

function boot() {
  const dom = new JSDOM(HTML, {
    url: 'http://localhost:8000/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const mock = makeFetchMock();
  window.fetch = mock.fetch;
  // jsdom 未实现布局相关方法，补空实现
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const ctx = dom.getInternalVMContext();
  vm.runInContext(APP_JS, ctx, { filename: 'static/app.js' });
  return { window, ctx, mock };
}

// 等待若干轮事件循环，让已 resolve 的 Promise 链（onCalibrate 的后续）跑完
async function settle(n = 6) {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
}

const q = (w, sel) => w.document.querySelector(sel);
const qa = (w, sel) => Array.from(w.document.querySelectorAll(sel));
const sampleRow = (w, i) => qa(w, '#sample-tbody tr')[i];
const measuredCell = (w, row, c) => sampleRow(w, row).querySelector(`.cd-m[data-c="${c}"]`);
const driveCell = (w, row, id) => sampleRow(w, row).querySelector(`.cd-drive[data-id="${id}"]`);
const channelIdCell = (w, i) => qa(w, '#channel-tbody tr')[i].querySelector('.f-id');
const channelRCell = (w, i) => qa(w, '#channel-tbody tr')[i].querySelector('.f-r');

// 模拟用户键入：改值并派发冒泡的 input 事件（与真实输入一致）
function type(w, el, value) {
  el.value = value;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
}

async function submitCalib(w) {
  q(w, '#calib-btn').click();
  await settle();
}

// 读取 app.js 内部状态（let 绑定不挂 window，需在同一 vm 上下文内求值）
const readState = (ctx, expr) => vm.runInContext(expr, ctx);

function calibUi(w) {
  return {
    resultShown: !q(w, '#calib-result').hidden,
    suggestionShown: !q(w, '#calib-suggestion').hidden,
    uniqueShown: !q(w, '#calib-unique-block').hidden,
    btnDisabled: q(w, '#calib-btn').disabled,
    btnText: q(w, '#calib-btn').textContent,
    bannerHidden: q(w, '#error-banner').className.includes('hidden'),
    bannerHtml: q(w, '#error-banner').innerHTML,
  };
}

// 迟到响应被丢弃后的统一断言：建议不复活、结果区不展开、按钮恢复可用
function assertStaleDiscarded(w, what) {
  const ui = calibUi(w);
  assert.strictEqual(ui.suggestionShown, false, `${what}：旧补测建议不得重新出现`);
  assert.strictEqual(ui.resultShown, false, `${what}：结果区不得重新展开`);
  assert.strictEqual(ui.btnDisabled, false, `${what}：无更新请求时按钮应恢复可用`);
  assert.strictEqual(ui.btnText, '反求满档读数', `${what}：按钮文案应恢复`);
}

/* ---------------- 测试用例 ---------------- */

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// 1) 在途期间清空实测零值（0 → 留空待填）：迟到的 non_unique 不得复活旧建议；
//    随后未填完整拒绝提交，填好后可正常重算
test('清空实测零值：迟到 non_unique 被丢弃，未填完整拒绝提交，填好可重算', async () => {
  const { window: w, ctx, mock } = boot();
  // 先把样本 #1 实测 R 改为 0（合法值），再提交
  type(w, measuredCell(w, 0, 0), '0');
  await submitCalib(w);
  assert.strictEqual(mock.calls.length, 1, '应发起 1 次标定请求');
  assert.strictEqual(calibUi(w).btnDisabled, true, '在途期间按钮应禁用');

  // 在途期间把该格清空（0 → 留空待填）：输入代次必须 +1
  const e0 = readState(ctx, 'calibEpoch');
  type(w, measuredCell(w, 0, 0), '');
  assert.ok(readState(ctx, 'calibEpoch') > e0, '清空实测（待填状态变化）应使输入代次 +1');
  assert.strictEqual(readState(ctx, 'calibSamples[0].measuredBlank[0]'), true);

  // 迟到的 non_unique 响应到达：必须被丢弃
  mock.respondOk(NON_UNIQUE);
  await settle();
  assertStaleDiscarded(w, '清空实测零值');

  // 实测未填完整：拒绝提交，不发起新请求
  await submitCalib(w);
  assert.strictEqual(mock.calls.length, 1, '未填完整不得发起请求');
  assert.ok(calibUi(w).bannerHtml.includes('未填完整'), '应提示实测未填完整');

  // 填好后重新提交：正常响应正常显示
  type(w, measuredCell(w, 0, 0), '5');
  await submitCalib(w);
  assert.strictEqual(mock.calls.length, 2, '填完整后应可重新标定');
  mock.respondOk(UNIQUE);
  await settle();
  assert.strictEqual(calibUi(w).uniqueShown, true, '重算的 unique 结果应正常显示');
});

// 2) 在途期间修改样本驱动后又改回原值：旧响应同样不得被接纳
test('编辑样本驱动后恢复原值：迟到 non_unique 被丢弃', async () => {
  const { window: w, ctx, mock } = boot();
  await submitCalib(w);
  assert.strictEqual(mock.calls.length, 1);

  const cell = driveCell(w, 0, 'R');
  const e0 = readState(ctx, 'calibEpoch');
  type(w, cell, '254'); // 改
  type(w, cell, '255'); // 再改回原值
  assert.ok(readState(ctx, 'calibEpoch') > e0, '编辑即失效，改回原值也不得回退代次');

  mock.respondOk(NON_UNIQUE);
  await settle();
  assertStaleDiscarded(w, '驱动改回原值');
});

// 3) 在途期间修改实测值后又改回原值：同样丢弃
test('编辑实测值后恢复原值：迟到 non_unique 被丢弃', async () => {
  const { window: w, mock } = boot();
  const before = measuredCell(w, 0, 0).value;
  await submitCalib(w);
  type(w, measuredCell(w, 0, 0), String(Number(before) + 1));
  type(w, measuredCell(w, 0, 0), before); // 改回原值
  mock.respondOk(NON_UNIQUE);
  await settle();
  assertStaleDiscarded(w, '实测值改回原值');
});

// 4) 在途期间修改通道 ID 后又改回原值：同样丢弃
test('编辑通道 ID 后恢复原值：迟到 non_unique 被丢弃', async () => {
  const { window: w, ctx, mock } = boot();
  await submitCalib(w);
  const e0 = readState(ctx, 'calibEpoch');
  type(w, channelIdCell(w, 0), 'RX');
  type(w, channelIdCell(w, 0), 'R'); // 改回原值
  assert.ok(readState(ctx, 'calibEpoch') > e0, '通道 ID 编辑即失效');
  mock.respondOk(NON_UNIQUE);
  await settle();
  assertStaleDiscarded(w, '通道 ID 改回原值');
});

// 5) 在途期间样本增删、载入示例：旧请求一并失效
test('在途添加样本：迟到 non_unique 被丢弃', async () => {
  const { window: w, ctx, mock } = boot();
  await submitCalib(w);
  const e0 = readState(ctx, 'calibEpoch');
  q(w, '#add-sample').click();
  assert.ok(readState(ctx, 'calibEpoch') > e0, '添加样本应使在途请求失效');
  mock.respondOk(NON_UNIQUE);
  await settle();
  assertStaleDiscarded(w, '在途添加样本');
});

test('在途删除样本：迟到 non_unique 被丢弃', async () => {
  const { window: w, mock } = boot();
  await submitCalib(w);
  sampleRow(w, 4).querySelector('.sample-del').click();
  mock.respondOk(NON_UNIQUE);
  await settle();
  assertStaleDiscarded(w, '在途删除样本');
});

test('在途载入示例：迟到 non_unique 被丢弃', async () => {
  const { window: w, mock } = boot();
  await submitCalib(w);
  q(w, '#reset-sample').click();
  mock.respondOk(NON_UNIQUE);
  await settle();
  assertStaleDiscarded(w, '在途载入示例');
});

// 6) 丢弃后重算：按钮恢复可用，合法输入重新标定正常出结果
test('丢弃后重算：按钮恢复，合法输入可重新标定并显示建议', async () => {
  const { window: w, mock } = boot();
  await submitCalib(w);
  type(w, driveCell(w, 0, 'R'), '200'); // 使在途请求失效
  mock.respondOk(NON_UNIQUE);
  await settle();
  assertStaleDiscarded(w, '丢弃旧响应');

  // 重新提交（按钮已恢复）：新响应必须正常受理
  await submitCalib(w);
  assert.strictEqual(mock.calls.length, 2, '应可重新发起标定');
  mock.respondOk(NON_UNIQUE);
  await settle();
  const ui = calibUi(w);
  assert.strictEqual(ui.suggestionShown, true, '重算的 non_unique 建议应正常显示');
  assert.strictEqual(ui.btnDisabled, false, '重算结束后按钮应恢复可用');
  assert.strictEqual(ui.btnText, '反求满档读数');
});

// 7) 按钮收尾：已有更新请求在途时，旧请求的到达与收尾都不得改动按钮与结果
test('按钮收尾：已有新请求时旧请求不得改动按钮，新请求正常收尾', async () => {
  const { window: w, ctx, mock } = boot();
  await submitCalib(w); // 请求 A 在途
  assert.strictEqual(calibUi(w).btnDisabled, true);
  assert.strictEqual(calibUi(w).btnText, '反求中…');

  type(w, driveCell(w, 0, 'R'), '200'); // 输入变化，A 已过期
  // 直接发起请求 B（绕过按钮禁用，模拟竞态下的更新请求）
  vm.runInContext('onCalibrate()', ctx);
  await settle();
  assert.strictEqual(mock.calls.length, 2, '应存在 A、B 两个在途请求');

  // A 的迟到响应到达：被丢弃，且 A 的收尾不得恢复按钮（B 仍在途）
  mock.respondOk(NON_UNIQUE);
  await settle();
  let ui = calibUi(w);
  assert.strictEqual(ui.suggestionShown, false, 'A 的旧建议不得出现');
  assert.strictEqual(ui.btnDisabled, true, 'B 在途时按钮不得被 A 恢复');
  assert.strictEqual(ui.btnText, '反求中…', 'B 在途时按钮文案不得被 A 改动');

  // B 的响应到达：正常显示，按钮由 B 收尾恢复
  mock.respondOk(NON_UNIQUE);
  await settle();
  ui = calibUi(w);
  assert.strictEqual(ui.suggestionShown, true, 'B 的建议应正常显示');
  assert.strictEqual(ui.btnDisabled, false, 'B 结束后按钮应恢复可用');
  assert.strictEqual(ui.btnText, '反求满档读数');
});

// 8) 按建议追加后，过期 422 失败响应不得覆盖当前提示、不得复活建议
test('按建议追加后，过期 422 响应不得覆盖当前提示、不得复活建议', async () => {
  const { window: w, mock } = boot();
  await submitCalib(w);
  mock.respondOk(NON_UNIQUE);
  await settle();
  assert.strictEqual(calibUi(w).suggestionShown, true, 'non_unique 建议应显示');

  // 按建议追加补测样本行：样本 +1、实测留空、旧结果清除、出现追加提示
  q(w, '#add-suggestion-btn').click();
  await settle();
  assert.strictEqual(qa(w, '#sample-tbody tr').length, 6, '应按建议追加 1 行');
  let ui = calibUi(w);
  assert.strictEqual(ui.resultShown, false, '追加后旧标定结果应清除');
  assert.ok(ui.bannerHtml.includes('已按补测建议追加'), '应出现追加提示');

  // 手工填完整新行实测，再次提交（请求 B 在途）
  type(w, measuredCell(w, 5, 0), '1');
  type(w, measuredCell(w, 5, 1), '1');
  type(w, measuredCell(w, 5, 2), '1');
  await submitCalib(w);
  assert.strictEqual(mock.calls.length, 2, '应发起第 2 次标定请求');

  // 在途期间再改样本（B 已过期）；追加提示横幅保持不变
  type(w, driveCell(w, 0, 'R'), '201');
  // B 的迟到 422 失败响应：不得覆盖当前提示，也不得复活建议
  mock.respondErr(422, { detail: '这段错误信息绝不应出现' });
  await settle();
  ui = calibUi(w);
  assert.ok(ui.bannerHtml.includes('已按补测建议追加'), '过期失败响应不得覆盖当前提示');
  assert.ok(!ui.bannerHtml.includes('绝不应出现'), '过期失败响应的内容不得上屏');
  assert.strictEqual(ui.suggestionShown, false, '过期失败响应不得复活建议');
  assert.strictEqual(ui.resultShown, false, '过期失败响应不得展开结果区');
  assert.strictEqual(ui.btnDisabled, false, '无更新请求时按钮应恢复可用');
});

// 9) 在途期间“按建议追加”：旧请求同样失效
test('在途期间按建议追加：迟到 non_unique 被丢弃', async () => {
  const { window: w, mock } = boot();
  await submitCalib(w);
  mock.respondOk(NON_UNIQUE);
  await settle();
  assert.strictEqual(calibUi(w).suggestionShown, true);

  // 再次提交（请求 B 在途，建议仍在显示），在途期间点击“按建议追加”
  await submitCalib(w);
  assert.strictEqual(mock.calls.length, 2);
  q(w, '#add-suggestion-btn').click();
  await settle();
  mock.respondOk(NON_UNIQUE);
  await settle();
  assertStaleDiscarded(w, '在途按建议追加');
  assert.strictEqual(qa(w, '#sample-tbody tr').length, 6, '追加的样本行应保留');
});

// 10) unique 结果与一键写回不受修复影响；非 ID 的通道值变化不使标定失效
test('unique 正常显示并可一键写回；通道满档值编辑不使在途标定失效', async () => {
  const { window: w, mock } = boot();
  // 改通道 R 的满档 R（非 ID，不影响标定请求内容）
  type(w, channelRCell(w, 0), '500');
  await submitCalib(w);
  assert.strictEqual(mock.calls.length, 1);
  mock.respondOk(UNIQUE);
  await settle();
  let ui = calibUi(w);
  assert.strictEqual(ui.uniqueShown, true, 'unique 结果应正常显示');
  assert.strictEqual(q(w, '#writeback-btn').disabled, false, '写回按钮应可用');

  q(w, '#writeback-btn').click();
  await settle();
  assert.strictEqual(channelRCell(w, 0).value, '1000', '写回应覆盖满档 R');
  ui = calibUi(w);
  assert.strictEqual(ui.uniqueShown, true, '写回后标定结果保留（既有行为）');
});

// 11) 正常 non_unique 流程回归：无干扰时建议与见证正常显示
test('正常 non_unique：建议、见证与追加按钮正常显示', async () => {
  const { window: w, mock } = boot();
  await submitCalib(w);
  mock.respondOk(NON_UNIQUE);
  await settle();
  const ui = calibUi(w);
  assert.strictEqual(ui.resultShown, true, '结果区应展开');
  assert.strictEqual(ui.suggestionShown, true, '补测建议应显示');
  const addBtn = q(w, '#add-suggestion-btn');
  assert.ok(addBtn, '应出现“按建议追加”按钮');
  assert.strictEqual(addBtn.disabled, false, '样本未满 12 组时追加按钮可用');
  assert.ok(q(w, '#calib-suggestion').innerHTML.includes('W'),
    '建议应指明补测通道');
  assert.strictEqual(ui.btnDisabled, false, '响应结束后按钮恢复可用');
});

/* ---------------- 运行 ---------------- */

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`[OK] ${name}`);
    } catch (e) {
      failed += 1;
      console.error(`[FAIL] ${name}`);
      console.error(e && e.stack ? e.stack : e);
    }
  }
  if (failed) {
    console.error(`\n${failed} 个用例失败 ✘`);
    process.exit(1);
  }
  console.log('\n全部通过 ✔');
})();
