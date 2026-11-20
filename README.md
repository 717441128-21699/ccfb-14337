# 养成游戏 · 日程与事件调度系统

一年 360 天、玩家每天排行程、角色有作息、事件触发靠策划填表的养成类文字游戏调度内核。
解决三个核心问题:**事件冲突有明确仲裁规则、错过的事件按策划配置顺延、玩家预约能挤动角色作息并级联重排**。

- 纯 TypeScript、零运行时依赖、确定性输出(相同输入必然得到相同队列,无随机数副作用)
- 引擎与 UI 分离,`src/core` 可直接进游戏服务端/客户端,`src/editor` 是策划编辑台

## 快速开始

```bash
npm install
npm test          # 47 个单元/性能/冒烟测试
npm run test:perf # 只跑性能验收
npm run dev       # 启动编辑台(http://localhost:5173)
npm run build:web # 编辑台生产构建 → dist-web/
npm run build     # 核心库类型声明构建 → dist/
```

编辑台顶栏「生成 360 天测试表」可一键造 1000 事件 + 960 条作息的全年规模数据(固定种子,可复现)。

## 资源模型

把两类东西统一成**容量为 1 的资源槽**,玩家行程、角色作息、事件竞争同一批槽位,共用一套仲裁规则:

| 资源 | 含义 |
| --- | --- |
| 角色 × 天 × 时段 | 一个角色同一时段只能在一个地点 |
| 地点 × 天 × 时段 | 同一地点同一时段容量为 1 |

占用优先级(高 → 低):**玩家行程 > 剧情锁定作息(不可移动)> 事件 > 可移动作息**。
底层是两张扁平 `Int32Array` 占用矩阵,查空/落位都是 O(1)。

## 事件冲突仲裁(全序决胜键)

同一天、同一地点/角色、同一时段有多个事件满足条件时,**逐级比较,先分胜负者得槽**:

1. `priority` 数值大者胜(策划主配)
2. 同优先级比 `deadlineDay`,截止日更早者胜(EDF,早deadline先安排,降低整体错过率)
3. 再相同比确定性哈希扰动:配了 `tieBreakWeight` 时,权重越大期望越靠前(FNV-1a 哈希,与数组顺序无关、可复现)
4. 最后比事件 id 字典序,保证结果唯一且确定

落选事件不会"永远错过"——进入下面的顺延状态机。另有 `exclusiveKey` 互斥组:同组事件同一天最多排一个。

## 顺延状态机(策划可配)

每个事件配 `postpone` 策略,错过槽位后按策略逐日重试:

| 策略 | 行为 | 终态 |
| --- | --- | --- |
| `none` | 不顺延,截止日仍没排上 | `missed` |
| `within-window` | 在 `[earliestDay, deadlineDay]` 窗口内逐日重试 | 排上 / 窗口耗尽 `missed` |
| `next-available` | 窗口结束后继续顺延到 `latestDelayDay` | 排上 / 到上限 `missed` |

- `maxPostponeCount`:最大顺延次数(默认 12),到顶即 `missed`,防止长尾事件无限重试
- **条件不满足的日子不消耗顺延次数**;条件从未满足过的事件终态是 `expired`(区别于资源竞争导致的 `missed`)
- 终态:`pending / active / scheduled / triggered / postponed / missed / expired`,全部在 `eventStatus` 里可查
- `repeatable` 事件触发后按原窗口长度重新装桶

## 角色作息迁移

玩家预约角色时,该角色原时段的可移动作息(`movable: true`)被挤掉,按条目配置找最近空档:

| 配置 | 含义 |
| --- | --- |
| `movePolicy: nearest` | 双向找最近:偏移 0 → +1 → -1 → +2 → -2…(默认) |
| `movePolicy: forward` | 只向后找 |
| `movePolicy: backward` | 只向前找 |
| `maxBackwardDays / maxForwardDays` | 迁移窗口(默认各 7 天) |
| `dropPolicy: drop` | 窗口内无处可去 → 丢弃,结果里 `dropped: true` |
| `dropPolicy: keep-conflict` | 迁不动 → 拒绝本次玩家预约并标 `conflict`,交人工处理 |
| `movable: false` | 剧情锁定,直接挡住预约(占用方不可让开) |

被挤掉的作息落位后,依赖该角色/地点的事件在后续日期的扫描中自动重新竞争槽位(级联重排)。
引擎采用确定性全量重算保证级联不产生脏状态;全年规模下耗时远低于预算。

## 触发条件

结构化表达式(`ConditionExpr`),编辑台用 JSON 编辑,引擎解释执行:
`all / any / not` 组合,以及 `stat / affection / flag / item / weekday / eventState / const` 叶子节点。
`eventState` 引用的事件依赖在保存时做**悬空引用**和**依赖环**校验。

## 静态校验(编辑台 + CI 可用)

`validateGameData` 输出三级问题:
- `error`:阻断排程(重复 id、越界日期、悬空地点/角色/事件引用、窗口反转、依赖环、非法策略)
- `warning`:不阻断(作息同时段重叠等)
- `info`:竞争预警(同地点同时段窗口重叠的事件对,提示策划确认优先级)

## 性能验收(见 `tests/perf.test.ts`,中位耗时)

| 场景 | 预算 | 实测(本机) |
| --- | --- | --- |
| 1000 事件排全年队列 | < 1000ms | ~20ms |
| 全部角色全年作息重排(960 条) | < 200ms | ~18ms |
| 40 条预约触发的增量重排(含迁移+级联) | < 200ms | ~19ms |

测试取 7~9 次运行中位数并预热,规避 GC/JIT 噪声。

## 目录结构

```
src/core/            引擎(无 DOM 依赖,可独立发布)
  types.ts           领域类型与配置契约
  condition.ts       触发条件解释器
  occupancy.ts       资源占用矩阵 + 确定性哈希 + id 索引
  validation.ts      静态校验(错误/警告/信息三级)
  scheduler.ts       调度引擎:仲裁、顺延状态机、作息迁移
  testData.ts        固定种子的 360 天规模测试数据生成器
src/editor/          策划编辑台(Vite + 原生 TS)
  state.ts           store / 初始示例数据
  app.ts             initEditor 工厂与顶栏
  panels/            事件表 / 作息行程 / 全年队列 / 校验 四个面板
tests/               47 个测试:仲裁、顺延、迁移、级联、校验、性能、UI 冒烟
```

## 引擎用法

```ts
import { Scheduler, generateGameData } from './src/core/index.js';

const data = generateGameData({ eventCount: 1000 });
const scheduler = new Scheduler(data);

// 全量构建
const result = scheduler.buildSchedule(playerActivities, {
  stats: { energy: 60 }, flags: { chapter_1_open: true }, affection: { char_01: 30 },
});

// 玩家编辑行程后的增量入口(内部确定性重算,返回合并后的行程与新队列)
const { result: next, activities, rejected } = scheduler.applyActivityPatch(
  currentActivities,
  { upserted: [newActivity], removedClientIds: ['old-id'] },
);
```
