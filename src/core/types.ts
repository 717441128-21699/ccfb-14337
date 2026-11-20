/**
 * 核心领域类型定义
 *
 * 时间模型:一年 360 天,每天划分为若干有序时段(slot,从 0 开始)。
 * 资源模型:「角色 × 天 × 时段」与「地点 × 天 × 时段」都是容量为 1 的资源槽,
 * 玩家行程、角色作息条目、事件三者竞争同一批槽位,共用一套优先级仲裁规则。
 */

export const TOTAL_DAYS = 360;

/** 一天中的时段 id,从 0 开始,具体个数由游戏配置(ScheduleConfig.slotsPerDay)决定 */
export type SlotId = number;

/** 天索引,0 ~ 359 */
export type Day = number;

/** 事件优先级,数值越大优先级越高 */
export type Priority = number;

/** 稳定 id(事件/角色/地点/条目) */
export type EntityId = string;

// ---------------------------------------------------------------------------
// 触发条件
// ---------------------------------------------------------------------------

/**
 * 触发条件表达式(可嵌套组合)。
 * 策划在编辑页里通过结构化表单拼出,引擎用 evaluateCondition 解释执行。
 */
export type ConditionExpr =
  | { kind: 'all'; of: ConditionExpr[] }
  | { kind: 'any'; of: ConditionExpr[] }
  | { kind: 'not'; expr: ConditionExpr }
  /** 游戏状态变量比较,如 { stat: 'energy', op: '>=', value: 50 } */
  | { kind: 'stat'; stat: string; op: CompareOp; value: number }
  /** 角色好感/关系值比较 */
  | { kind: 'affection'; character: EntityId; op: CompareOp; value: number }
  /** 标志位判断(任务完成、章节解锁等) */
  | { kind: 'flag'; flag: string; value: boolean }
  /** 物品/道具持有数量 */
  | { kind: 'item'; item: EntityId; op: CompareOp; value: number }
  /** 星期几(六天工作制,0~5),支持多个取值 */
  | { kind: 'weekday'; days: number[] }
  /** 前置事件:要求某事件已触发 / 已错过 / 已过期 */
  | { kind: 'eventState'; event: EntityId; state: EventLifecycleState }
  /** 永真/永假,用于占位与测试 */
  | { kind: 'const'; value: boolean };

export type CompareOp = '>=' | '<=' | '>' | '<' | '==' | '!=';

/** 条件求值上下文:由游戏侧(或测试桩)提供 */
export interface ConditionContext {
  day: Day;
  stats: Readonly<Record<string, number>>;
  flags: Readonly<Record<string, boolean>>;
  items: Readonly<Record<string, number>>;
  affection: Readonly<Record<string, number>>;
  /** 事件生命周期状态快照:eventId -> state */
  eventStates: Readonly<Record<string, EventLifecycleState>>;
}

// ---------------------------------------------------------------------------
// 顺延与迁移策略(策划可配)
// ---------------------------------------------------------------------------

/** 事件落选后的顺延策略 */
export enum PostponePolicy {
  /** 不顺延:窗口最后一天仍未排上即 missed */
  None = 'none',
  /** 仅在 [earliestDay, deadlineDay] 窗口内逐日重试,窗口结束未排上即 missed */
  WithinWindow = 'within-window',
  /** 向窗口之后顺延,直到 latestDelayDay;期间逐日重试 */
  NextAvailable = 'next-available',
}

/** 角色作息条目被挤掉后的迁移策略 */
export enum MovePolicy {
  /** 只向目标日之后找最近空档 */
  Forward = 'forward',
  /** 只向目标日之前找最近空档 */
  Backward = 'backward',
  /** 双向,从偏移 0 开始交替找最近空档(默认) */
  Nearest = 'nearest',
}

/** 迁不动时的丢弃规则 */
export enum DropPolicy {
  /** 直接丢弃 */
  Drop = 'drop',
  /** 保留在原日并标记冲突(由策划/玩家后续处理) */
  KeepConflict = 'keep-conflict',
}

// ---------------------------------------------------------------------------
// 事件定义(策划手填的大表行)
// ---------------------------------------------------------------------------

export interface EventDef {
  id: EntityId;
  title: string;
  /** 触发窗口 */
  earliestDay: Day;
  deadlineDay: Day;
  /** 触发时段;null 表示全天任意时段均可(按候选顺序占用第一个空位) */
  slot: SlotId | null;
  locationId: EntityId;
  /** 需要在场的角色;可为空 */
  characterIds: EntityId[];
  /** 触发条件,永真条件用 { kind: 'const', value: true } */
  condition: ConditionExpr;
  /** 数值越大优先级越高,默认 0 */
  priority: Priority;
  /** 同优先级的稳定决胜随机权重:0 表示纯 id 决胜;>0 时按确定性哈希扰动 */
  tieBreakWeight: number;
  postpone: PostponePolicy;
  /** postpone = next-available 时的最终顺延下限(含),默认 = deadlineDay */
  latestDelayDay?: Day;
  /** 最大顺延次数,防止长尾事件无限重试;默认 12 */
  maxPostponeCount?: number;
  /** 一组事件声明同一 exclusiveKey 时,同一时间最多触发其中一个(额外的互斥层) */
  exclusiveKey?: string;
  /** 一次性(默认)还是可重复事件;可重复事件触发后窗口重置 */
  repeatable?: boolean;
  /** 备注,仅编辑页使用 */
  note?: string;
}

// ---------------------------------------------------------------------------
// 角色作息
// ---------------------------------------------------------------------------

export interface RoutineEntry {
  id: EntityId;
  characterId: EntityId;
  day: Day;
  slot: SlotId;
  locationId: EntityId;
  /** 玩家预约优先级高于可移动作息;不可移动条目(剧情锁定)不会被挤 */
  movable: boolean;
  movePolicy: MovePolicy;
  /** 向前最多挪几天(含目标日),默认 7 */
  maxBackwardDays?: number;
  /** 向后最多挪几天(含目标日),默认 7 */
  maxForwardDays?: number;
  dropPolicy: DropPolicy;
  /** 关联的事件 id(若该作息由事件生成),重排时级联处理用 */
  sourceEventId?: EntityId;
  note?: string;
}

// ---------------------------------------------------------------------------
// 玩家行程
// ---------------------------------------------------------------------------

export interface PlayerActivity {
  /** 客户端给的临时 id,用于增量 diff */
  clientId: EntityId;
  day: Day;
  slot: SlotId;
  locationId: EntityId;
  /** 预约的角色;为空表示单人行程 */
  characterIds: EntityId[];
  /** 关联事件 id(行程用于触发某事件时) */
  triggerEventId?: EntityId;
  note?: string;
}

// ---------------------------------------------------------------------------
// 调度配置与静态数据
// ---------------------------------------------------------------------------

export interface ScheduleConfig {
  totalDays: number;
  slotsPerDay: number;
  locationIds: EntityId[];
  characterIds: EntityId[];
}

export interface GameData {
  config: ScheduleConfig;
  events: EventDef[];
  routines: RoutineEntry[];
}

// ---------------------------------------------------------------------------
// 调度结果
// ---------------------------------------------------------------------------

/** 事件在整个生命周期中的状态 */
export type EventLifecycleState =
  | 'pending'        // 尚未进入窗口
  | 'active'         // 在窗口内、等待排期
  | 'scheduled'      // 已占用槽位(等待那天到来)
  | 'triggered'      // 已实际触发
  | 'postponed'      // 被顺延(仍会重试)
  | 'missed'         // 窗口/顺延上限耗尽,永久错过
  | 'expired';       // 条件始终不满足而过期

export interface ScheduledEvent {
  eventId: EntityId;
  day: Day;
  slot: SlotId;
  locationId: EntityId;
  characterIds: EntityId[];
  /** 0 表示当天直接排上,>0 表示经过了多少次顺延 */
  postponeCount: number;
}

export interface RoutinePlacement {
  entryId: EntityId;
  characterId: EntityId;
  originalDay: Day;
  day: Day;
  slot: SlotId;
  locationId: EntityId;
  /** 相对原始日的偏移;0 表示未动 */
  movedByDays: number;
  dropped: boolean;
  conflict: boolean;
}

export interface RejectedActivity {
  clientId: EntityId;
  reason: string;
}

export interface EventStatusRow {
  eventId: EntityId;
  state: EventLifecycleState;
  /** 实际/计划触发日;未排期为 null */
  scheduledDay: Day | null;
  postponeCount: number;
}

export interface ScheduleResult {
  /** 排上的事件,按 (day, slot) 排序 */
  scheduledEvents: ScheduledEvent[];
  /** 全部事件的最终状态表 */
  eventStatus: EventStatusRow[];
  /** 角色作息的最终落位(含被丢弃/冲突标记) */
  routinePlacements: RoutinePlacement[];
  /** 被引擎拒绝的玩家行程(角色同时段冲突等) */
  rejectedActivities: RejectedActivity[];
  /** 调度统计与诊断信息 */
  stats: ScheduleStats;
}

export interface ScheduleStats {
  totalEvents: number;
  triggeredView: number;
  scheduled: number;
  postponedTotal: number;
  missed: number;
  expired: number;
  routinesMoved: number;
  routinesDropped: number;
  /** 事件调度主循环的候选尝试次数,性能/诊断用 */
  candidateTries: number;
  /** 引擎耗时(毫秒),由调用方填充 */
  elapsedMs?: number;
}

/** 一次玩家行程编辑(增量重排输入) */
export interface ActivityPatch {
  /** 新增/修改后的行程(全量提交这一天或整组即可,引擎按 clientId diff) */
  upserted: PlayerActivity[];
  /** 移除的行程 clientId */
  removedClientIds: EntityId[];
}
