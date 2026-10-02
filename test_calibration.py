"""满档读数标定的冒烟测试（不依赖 pytest，可直接 python3 运行）。

重点：
  * unique / contradictory / non_unique 三态判定正确；
  * unique 用全空间穷举独立核对（d∈{0,255} 单路点亮时可穷举 x∈[0,39]）；
  * 四舍五入（半值向上）的整数线性化边界 127/128；
  * schema 对非法样本一律 422。
"""

import itertools
import random
import sys

sys.path.insert(0, "/workspace")

from pydantic import ValidationError

from app.calibration import (
    CalibSample,
    calibrate,
    predicted_rgb,
    round_half_up,
)
from app.schemas import CalibrateRequest

IDS3 = ["R", "G", "B"]
TRUTH3 = [(1000, 120, 40), (160, 1000, 90), (60, 80, 1000)]


def mk(drives, truth=TRUTH3):
    return CalibSample(tuple(drives), predicted_rgb(truth, tuple(drives)))


def expect(name, ids, samples, want):
    r = calibrate(ids, samples, time_limit_seconds=10)
    assert r.status == want, f"{name}: 期望 {want}，实得 {r.status}（{r.message}）"
    print(f"[OK] {name}: {r.status}")
    return r


# 1) 唯一：三路各自满档单亮 + 1 组混合
r = expect(
    "单路满档+混合=唯一",
    IDS3,
    [mk((255, 0, 0)), mk((0, 255, 0)), mk((0, 0, 255)), mk((128, 200, 64))],
    "unique",
)
assert r.channels == [("R", *TRUTH3[0]), ("G", *TRUTH3[1]), ("B", *TRUTH3[2])]

# 2) 唯一结果确实在四舍五入口径下解释每个样本
for smp in [mk((255, 0, 0)), mk((0, 255, 0)), mk((0, 0, 255)), mk((128, 200, 64))]:
    assert predicted_rgb(TRUTH3, smp.drives) == smp.measured

# 3) 矛盾：同一驱动组合两次实测互斥（d=255 时 m 唯一确定 x，999 与 998 矛盾）
expect(
    "同组合两次互斥实测=矛盾",
    IDS3,
    [
        CalibSample((255, 0, 0), (999, 120, 40)),
        CalibSample((255, 0, 0), (998, 120, 40)),
        mk((0, 255, 0)),
        mk((0, 0, 255)),
    ],
    "contradictory",
)

# 4) 矛盾：单路满档点亮实测全零，但该路三色不全为零被强制
expect(
    "满档点亮实测全零=矛盾",
    IDS3,
    [
        CalibSample((255, 0, 0), (0, 0, 0)),
        mk((0, 255, 0)),
        mk((0, 0, 255)),
        mk((10, 10, 10)),
    ],
    "contradictory",
)

# 5) 不唯一：B 路从未被驱动（B 完全不可观测）
expect(
    "一路从不点亮=不唯一",
    IDS3,
    [mk((255, 0, 0)), mk((0, 255, 0)), mk((100, 100, 0))],
    "non_unique",
)

# 6) 不唯一：只有 d=1 的观测，四舍五入带映射到 255 标度上宽于 1 个整数
expect(
    "驱动过小测量粒度粗=不唯一",
    IDS3,
    [mk((1, 0, 0)), mk((0, 1, 0)), mk((0, 0, 1))],
    "non_unique",
)

# 7) 全零样本合法（与单路样本一起仍唯一）
r = expect(
    "含全零样本仍唯一",
    IDS3,
    [mk((0, 0, 0)), mk((255, 0, 0)), mk((0, 255, 0)), mk((0, 0, 255))],
    "unique",
)
assert r.channels == [("R", *TRUTH3[0]), ("G", *TRUTH3[1]), ("B", *TRUTH3[2])]

# 8) 6 路 12 组（上限）唯一
IDS6 = ["A", "B", "C", "D", "E", "F"]
TRUTH6 = [
    (1000, 0, 0), (0, 1000, 0), (0, 0, 1000),
    (820, 800, 760), (950, 600, 60), (10, 990, 400),
]
random.seed(7)
samples6 = []
for i in range(6):
    ds = tuple(255 if j == i else 0 for j in range(6))
    samples6.append(mk(ds, TRUTH6))
while len(samples6) < 12:
    ds = tuple(random.randint(0, 255) for _ in range(6))
    samples6.append(mk(ds, TRUTH6))
r = expect("6路12组=唯一", IDS6, samples6, "unique")
assert r.channels == [(i, *v) for i, v in zip(IDS6, TRUTH6)]


# 9) 穷举独立核对三态：驱动只取 {0,255}、真值 x∈[0,39] 时，单路点亮样本的
#    实测 m 精确等于该路 x，可在 40^9 子空间（约 2.6×10^14 全空间太大，
#    这里按样本结构顺序枚举 3 路 × 3 色、且单色样本可逐路分解）核对。
def solutions_for_channel(samples_for_color_pairs):
    """samples_for_color_pairs: [(active_channel_index or None for mixed,
                                  measured_color_vec)]。
    为简化，穷举核对只采用“单路点亮”样本：返回每路 x 三元组的解集数。"""
    per_channel_allowed = []
    for i in range(3):
        ms = [m for (ch, m) in samples_for_color_pairs if ch == i]
        allowed = []
        for x in itertools.product(range(40), repeat=3):
            if x == (0, 0, 0):
                continue
            if all(tuple(round_half_up(x[c] * 255 / 255) for c in range(3)) == tuple(m)
                   for m in ms):
                allowed.append(x)
        per_channel_allowed.append(allowed)
    return per_channel_allowed


# 9a) 每路单亮 → 每路恰好 1 个允许三元组 → 总解唯一
single = [
    (0, (7, 1, 0)),
    (1, (2, 30, 4)),
    (2, (0, 5, 33)),
]
allowed = solutions_for_channel(single)
assert all(len(a) == 1 for a in allowed), [len(a) for a in allowed]
expect(
    "穷举核对-唯一",
    IDS3,
    [CalibSample(tuple(255 if i == ch else 0 for i in range(3)), m) for ch, m in single],
    "unique",
)

# 9b) 第 3 路无样本约束 → 该路允许大量取值 → 不唯一
missing = single[:2]
allowed = solutions_for_channel(missing)
assert len(allowed[0]) == 1 and len(allowed[1]) == 1 and len(allowed[2]) > 1
expect(
    "穷举核对-不唯一",
    IDS3,
    [CalibSample(tuple(255 if i == ch else 0 for i in range(3)), m) for ch, m in missing],
    "non_unique",
)

# 9c) 第 1 路两组单亮实测互斥 → 该路允许集为空 → 矛盾
contra = single + [(0, (8, 1, 0))]
allowed = solutions_for_channel(contra)
assert len(allowed[0]) == 0
expect(
    "穷举核对-矛盾",
    IDS3,
    [CalibSample(tuple(255 if i == ch else 0 for i in range(3)), m) for ch, m in contra],
    "contradictory",
)

# 10) d=255 单峰样本：x 必须精确等于 m（0～1000 域内也唯一）
one = [
    CalibSample((255, 0, 0), (372, 0, 0)),
    CalibSample((0, 255, 0), (0, 410, 0)),
    CalibSample((0, 0, 255), (0, 0, 555)),
]
r = expect("单路单峰整数=唯一", IDS3, one, "unique")
assert r.channels == [("R", 372, 0, 0), ("G", 0, 410, 0), ("B", 0, 0, 555)]
allowed_r = [
    x for x in range(1001)
    if 255 * (2 * 372 - 1) <= 2 * x * 255 <= 255 * (2 * 372 + 1) - 1
]
assert allowed_r == [372], allowed_r

# 11) 四舍五入边界：S/255 = 0.4980…(S=127) → 0；=0.5019…(S=128) → 1
assert round_half_up(127 / 255) == 0 and round_half_up(128 / 255) == 1
assert round_half_up(2.5) == 3 and round_half_up(3.5) == 4

# 12) schema 非法样本全部 422
def reject(name, **body):
    try:
        CalibrateRequest(**body)
    except ValidationError:
        print(f"[OK] {name}: 422 拒绝")
        return
    raise AssertionError(f"{name}: 应拒绝却通过")


ch3 = [{"id": "R"}, {"id": "G"}, {"id": "B"}]
ok3 = [
    {"drives": [255, 0, 0], "measured": [1000, 0, 0]},
    {"drives": [0, 255, 0], "measured": [0, 1000, 0]},
    {"drives": [0, 0, 255], "measured": [0, 0, 1000]},
]
CalibrateRequest(channels=ch3, samples=ok3)  # 基线合法
reject("通道数 2", channels=ch3[:2], samples=ok3)
reject("通道数 7", channels=[{"id": i} for i in "ABCDEFG"],
       samples=[{"drives": [0] * 7, "measured": [0, 0, 0]}] * 3)
reject("ID 重复", channels=[{"id": "R"}, {"id": "R"}, {"id": "B"}], samples=ok3)
reject("ID 空白", channels=[{"id": " "}, {"id": "G"}, {"id": "B"}], samples=ok3)
reject("样本数 2", channels=ch3, samples=ok3[:2])
reject("样本数 13", channels=ch3, samples=ok3 * 4 + ok3[:1])
reject("驱动级 256", channels=ch3,
       samples=[{"drives": [256, 0, 0], "measured": [0, 0, 0]}] + ok3[1:])
reject("驱动级 -1", channels=ch3,
       samples=[{"drives": [-1, 0, 0], "measured": [0, 0, 0]}] + ok3[1:])
reject("实测 6001", channels=ch3,
       samples=[{"drives": [255, 0, 0], "measured": [6001, 0, 0]}] + ok3[1:])
reject("实测 2 分量", channels=ch3,
       samples=[{"drives": [255, 0, 0], "measured": [0, 0]}] + ok3[1:])
reject("驱动数与通道不符", channels=ch3,
       samples=[{"drives": [255, 0], "measured": [0, 0, 0]}] + ok3[1:])
reject("驱动为浮点", channels=ch3,
       samples=[{"drives": [1.5, 0, 0], "measured": [0, 0, 0]}] + ok3[1:])


# 13) non_unique 附带一次可执行补测建议（其他状态不提供建议）
def assert_non_unique_suggestion(name, ids, samples, truth=None):
    r = calibrate(ids, samples, time_limit_seconds=10)
    assert r.status == "non_unique", f"{name}: 期望 non_unique，实得 {r.status}"
    sg = r.suggestion
    assert sg is not None, f"{name}: non_unique 必须附带补测建议"
    n = len(ids)
    # 驱动向量：恰有一路 255、其余全 0
    assert len(sg.drives) == n and sorted(sg.drives) == [0] * (n - 1) + [255]
    p = sg.channel_index
    assert 0 <= p < n and sg.drives[p] == 255
    assert len(sg.witnesses) == 2
    w1, w2 = sg.witnesses
    m1, m2 = w1.matrix, w2.matrix
    # 两组合法满档 RGB：每路三色不全为零、取值 0～1000、矩阵确实不同
    assert m1 != m2
    for mat in (m1, m2):
        assert len(mat) == n
        for row in mat:
            assert all(0 <= v <= 1000 for v in row) and row != (0, 0, 0)
    # 两组见证都能解释全部原样本
    for mat in (m1, m2):
        for smp in samples:
            assert predicted_rgb(list(mat), smp.drives) == smp.measured, \
                f"{name}: 见证未能解释样本 {smp}"
    # 单路点亮时预测整数 RGB 恰为该路满档读数，两组见证该路不同 ⇒ 预测不同
    assert w1.predicted == m1[p] and w2.predicted == m2[p]
    assert w1.predicted != w2.predicted
    print(f"[OK] {name}: 补测建议（点亮 {ids[p]}，见证预测 {w1.predicted} vs {w2.predicted}）")
    return r


r = assert_non_unique_suggestion(
    "一路从不点亮-补测建议",
    IDS3,
    [mk((255, 0, 0)), mk((0, 255, 0)), mk((100, 100, 0))],
)

assert_non_unique_suggestion(
    "驱动过小粒度粗-补测建议",
    IDS3,
    [mk((1, 0, 0)), mk((0, 1, 0)), mk((0, 0, 1))],
)

# 14) 按建议补测（用真值实测）后按原流程重算 → 唯一，且写回参数等于真值
sg = r.suggestion
probe_measured = predicted_rgb(TRUTH3, sg.drives)
r2 = calibrate(
    IDS3,
    [mk((255, 0, 0)), mk((0, 255, 0)), mk((100, 100, 0)),
     CalibSample(sg.drives, probe_measured)],
    time_limit_seconds=10,
)
assert r2.status == "unique", r2.status
assert r2.channels == [("R", *TRUTH3[0]), ("G", *TRUTH3[1]), ("B", *TRUTH3[2])]
assert r2.suggestion is None
print("[OK] 按建议补测后重算=唯一且无建议")

# 15) unique / contradictory 不提供建议
assert calibrate(
    IDS3,
    [mk((255, 0, 0)), mk((0, 255, 0)), mk((0, 0, 255))],
    time_limit_seconds=10,
).suggestion is None
assert calibrate(
    IDS3,
    [
        CalibSample((255, 0, 0), (999, 120, 40)),
        CalibSample((255, 0, 0), (998, 120, 40)),
        mk((0, 255, 0)),
        mk((0, 0, 255)),
    ],
    time_limit_seconds=10,
).suggestion is None
print("[OK] unique/contradictory 不提供补测建议")

# 16) 响应模型（CalibrateResponse）能序列化建议，且拒绝畸形建议
from app.schemas import CalibrateResponse, CalibSuggestion, CalibWitness

resp = CalibrateResponse(
    status="non_unique",
    channels=[],
    suggestion=CalibSuggestion(
        channel_id="B",
        drives=[0, 0, 255],
        witnesses=[
            CalibWitness(
                matrix=[
                    {"id": "R", "r": 1000, "g": 120, "b": 40},
                    {"id": "G", "r": 160, "g": 1000, "b": 90},
                    {"id": "B", "r": 1, "g": 0, "b": 0},
                ],
                predicted=[1, 0, 0],
            ),
            CalibWitness(
                matrix=[
                    {"id": "R", "r": 1000, "g": 120, "b": 40},
                    {"id": "G", "r": 160, "g": 1000, "b": 90},
                    {"id": "B", "r": 1, "g": 1, "b": 1},
                ],
                predicted=[1, 1, 1],
            ),
        ],
    ),
    message="x",
)
payload = resp.model_dump()
assert payload["suggestion"]["drives"] == [0, 0, 255]
assert payload["suggestion"]["channel_id"] == "B"
print("[OK] CalibrateResponse 序列化补测建议")


def reject_suggestion(name, **kw):
    try:
        CalibSuggestion(**kw)
    except ValidationError:
        print(f"[OK] {name}: 拒绝畸形建议")
        return
    raise AssertionError(f"{name}: 应拒绝却通过")


good_w = lambda br, bg, bb, pr, pg, pb: CalibWitness(
    matrix=[
        {"id": "R", "r": 1000, "g": 120, "b": 40},
        {"id": "G", "r": 160, "g": 1000, "b": 90},
        {"id": "B", "r": br, "g": bg, "b": bb},
    ],
    predicted=[pr, pg, pb],
)
good_kw = dict(
    channel_id="B",
    drives=[0, 0, 255],
    witnesses=[good_w(1, 0, 0, 1, 0, 0), good_w(1, 1, 1, 1, 1, 1)],
)
CalibSuggestion(**good_kw)  # 基线合法
reject_suggestion("驱动两个255", **{**good_kw, "drives": [255, 0, 255]})
reject_suggestion("驱动含非0/255", **{**good_kw, "drives": [0, 1, 255]})
reject_suggestion("见证预测相同", **{**good_kw, "witnesses": [
    good_w(1, 0, 0, 1, 0, 0), good_w(1, 1, 1, 1, 0, 0)]})
reject_suggestion("见证矩阵相同", **{**good_kw, "witnesses": [
    good_w(1, 0, 0, 1, 0, 0), good_w(1, 0, 0, 1, 0, 0)]})
reject_suggestion("见证全零路", **{**good_kw, "witnesses": [
    CalibWitness(matrix=[
        {"id": "R", "r": 1000, "g": 120, "b": 40},
        {"id": "G", "r": 160, "g": 1000, "b": 90},
        {"id": "B", "r": 0, "g": 0, "b": 0}], predicted=[0, 0, 0]),
    good_w(1, 1, 1, 1, 1, 1)]})
reject_suggestion("见证矩阵通道数不符", **{**good_kw, "witnesses": [
    CalibWitness(matrix=[{"id": "R", "r": 1, "g": 0, "b": 0}], predicted=[1, 0, 0]),
    good_w(1, 1, 1, 1, 1, 1)]})

print("\n全部通过 ✔")
