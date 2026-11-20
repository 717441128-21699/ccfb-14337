import { evaluateCondition } from './condition.js';
import {
  IdIndex,
  Occupancy,
  OWNER_EVENT,
  OWNER_PLAYER,
  fnv1aHash,
} from './occupancy.js';
import {
  DropPolicy,
  MovePolicy,
  PostponePolicy,
  type ActivityPatch,
  type ConditionContext,
  type Day,
  type EventDef,
  type EventLifecycleState,
  type EventStatusRow,
  type GameData,
  type PlayerActivity,
  type RejectedActivity,
  type RoutineEntry,
  type RoutinePlacement,
  type ScheduleResult,
  type ScheduledEvent,
  type ScheduleStats,
  type SlotId,
} from './types.js';

/** 游戏侧状态快照;不给的字段按零值处理 */
export interface StateSnapshot {
  stats?: Record<string, number>;
  flags?: Record<string, boolean>;
  items?: Record<string, number>;
  affection?: Record<string, number>;
}

interface EventRuntime {
  def: EventDef;
  state: EventLifecycleState;
  postponeCount: number;
  conditionEverTrue: boolean;
  scheduledDay: Day | null;
  scheduledSlot: SlotId | null;
}

const DEFAULT_MAX_POSTPONE = 12;

/**
 * 调度引擎(无状态随机、确定性输出:同样的输入必然得到同样的全年队列)。
 *
 * 三阶段流水:
 *   1. 角色作息落位(含静态重叠时的迁移)
 *   2. 玩家行程落位(高优先级,挤掉可移动作息)
 *   3. 事件按天扫描,全序键仲裁 + 顺延状态机
 */
export class Scheduler {
  private readonly data: GameData;
  private readonly charIndex: IdIndex;
  private readonly locIndex: IdIndex;

  constructor(data: GameData) {
    this.data = data;
    this.charIndex = new IdIndex(data.config.characterIds);
    this.locIndex = new IdIndex(data.config.locationIds);
  }

  // ==========================================================================
  // 对外入口
  // ==========================================================================

  /** 全量构建全年队列 */
  buildSchedule(activities: readonly PlayerActivity[] = [], state: StateSnapshot = {}): ScheduleResult {
    const startedAt = nowMs();
    const { config } = this.data;
    const occupancy = new Occupancy(
      this.charIndex.size,
      this.locIndex.size,
      config.totalDays,
      config.slotsPerDay,
    );

    const placements = this.placeRoutines(occupancy);
    const { accepted, rejected } = this.placePlayerActivities(occupancy, placements, activities);
    const eventResult = this.scheduleEvents(occupancy, state);

    const stats: ScheduleStats = {
      totalEvents: this.data.events.length,
      triggeredView: eventResult.scheduled.length,
      scheduled: eventResult.scheduled.length,
      postponedTotal: eventResult.statuses.reduce((sum, r) => sum + r.postponeCount, 0),
      missed: eventResult.statuses.filter((r) => r.state === 'missed').length,
      expired: eventResult.statuses.filter((r) => r.state === 'expired').length,
      routinesMoved: placements.filter((p) => p.movedByDays !== 0 && !p.dropped).length,
      routinesDropped: placements.filter((p) => p.dropped).length,
      candidateTries: eventResult.candidateTries,
      elapsedMs: nowMs() - startedAt,
    };

    return {
      scheduledEvents: eventResult.scheduled,
      eventStatus: eventResult.statuses,
      routinePlacements: placements.map((p) => ({ ...p })),
      rejectedActivities: rejected,
      stats,
    };
  }

  /**
   * 增量入口:对当前行程应用一次编辑补丁,返回新队列。
   * 内部走确定性全量重算(带索引复用),保证级联重排不会出现脏状态;
   * 全年规模下耗时在性能预算内(见 tests/perf.test.ts)。
   */
  applyActivityPatch(
    currentActivities: readonly PlayerActivity[],
    patch: ActivityPatch,
    state: StateSnapshot = {},
  ): { result: ScheduleResult; activities: PlayerActivity[]; rejected: RejectedActivity[] } {
    const byId = new Map(currentActivities.map((a) => [a.clientId, a]));
    for (const removed of patch.removedClientIds) byId.delete(removed);
    for (const upsert of patch.upserted) byId.set(upsert.clientId, upsert);

    const merged = [...byId.values()].sort((a, b) => a.day - b.day || a.slot - b.slot);
    const result = this.buildSchedule(merged, state);
    const rejectedIds = new Set(result.rejectedActivities.map((r) => r.clientId));
    const accepted = merged.filter((a) => !rejectedIds.has(a.clientId));
    return { result, activities: accepted, rejected: result.rejectedActivities };
  }

  // ==========================================================================
  // 阶段 1:角色作息落位
  // ==========================================================================

  private placeRoutines(occupancy: Occupancy): RoutinePlacement[] {
    const placements: RoutinePlacement[] = this.data.routines.map((entry) => ({
      entryId: entry.id,
      characterId: entry.characterId,
      originalDay: entry.day,
      day: entry.day,
      slot: entry.slot,
      locationId: entry.locationId,
      movedByDays: 0,
      dropped: false,
      conflict: false,
    }));

    for (let i = 0; i < this.data.routines.length; i++) {
      const entry = this.data.routines[i]!;
      const placement = placements[i]!;
      const ref = i + 1; // ownerRef = 下标 + 1(0 留给空闲)
      const ci = this.charIndex.index(entry.characterId);
      const li = this.locIndex.index(entry.locationId);

      const target = this.findRoutineSlot(occupancy, entry, ci, li, entry.day);
      if (target !== null) {
        placement.day = target;
        placement.movedByDays = target - entry.day;
        occupancy.setCharOwner(ci, target, entry.slot, ref);
        occupancy.setLocOwner(li, target, entry.slot, ref);
      } else if (entry.dropPolicy === DropPolicy.Drop) {
        placement.dropped = true;
      } else {
        // KeepConflict:留在原日并标记冲突,交给策划/玩家处理
        placement.conflict = true;
        occupancy.setCharOwner(ci, entry.day, entry.slot, ref);
        occupancy.setLocOwner(li, entry.day, entry.slot, ref);
      }
    }
    return placements;
  }

  /**
   * 按条目配置的迁移策略找最近空档。
   * nearest:偏移 0, +1, -1, +2, -2 …;forward/backward 单向往外。
   *
   * @param targetDay 被挤占的目标日(玩家预约日);该日一定不可用,
   *                  初始落位时 targetDay = entry.day
   * @param forbiddenDay 额外禁止落位的日子(玩家预约日),-1 表示无
   */
  private findRoutineSlot(
    occupancy: Occupancy,
    entry: RoutineEntry,
    charIdx: number,
    locIdx: number,
    targetDay: Day,
    forbiddenDay: Day = -1,
  ): Day | null {
    const { totalDays } = this.data.config;
    const maxBack = entry.maxBackwardDays ?? 7;
    const maxFwd = entry.maxForwardDays ?? 7;
    const lower = Math.max(0, targetDay - maxBack);
    const upper = Math.min(totalDays - 1, targetDay + maxFwd);

    const freeAt = (day: Day): boolean =>
      day !== forbiddenDay &&
      occupancy.getCharOwner(charIdx, day, entry.slot) === 0 &&
      occupancy.getLocOwner(locIdx, day, entry.slot) === 0;

    const tryRange = (day: Day): Day | null =>
      day >= lower && day <= upper && freeAt(day) ? day : null;

    switch (entry.movePolicy) {
      case MovePolicy.Forward:
        for (let d = targetDay; d <= upper; d++) if (freeAt(d)) return d;
        return null;
      case MovePolicy.Backward:
        for (let d = targetDay; d >= lower; d--) if (freeAt(d)) return d;
        return null;
      case MovePolicy.Nearest: {
        const atZero = tryRange(targetDay);
        if (atZero !== null) return atZero;
        for (let offset = 1; offset <= Math.max(maxBack, maxFwd); offset++) {
          const forward = tryRange(targetDay + offset);
          if (forward !== null) return forward;
          const backward = tryRange(targetDay - offset);
          if (backward !== null) return backward;
        }
        return null;
      }
      default: {
        const _exhaustive: never = entry.movePolicy;
        throw new Error(`未知迁移策略: ${String(_exhaustive)}`);
      }
    }
  }

  // ==========================================================================
  // 阶段 2:玩家行程(高优先级占用)
  // ==========================================================================

  private placePlayerActivities(
    occupancy: Occupancy,
    placements: RoutinePlacement[],
    activities: readonly PlayerActivity[],
  ): { accepted: PlayerActivity[]; rejected: RejectedActivity[] } {
    const rejected: RejectedActivity[] = [];
    const accepted: PlayerActivity[] = [];
    const entryById = new Map(this.data.routines.map((r) => [r.id, r]));

    const isMovable = (ref: number): boolean => {
      const placement = placements[ref - 1]!;
      const entry = entryById.get(placement.entryId)!;
      return entry.movable && !placement.dropped && !placement.conflict;
    };

    for (const act of activities) {
      const charIndices = act.characterIds.map((id) => this.charIndex.index(id));
      const locIdx = this.locIndex.index(act.locationId);

      const check = occupancy.checkPlayerActivity(charIndices, locIdx, act.day, act.slot, isMovable);
      if (check && 'blockedBy' in check) {
        rejected.push({ clientId: act.clientId, reason: this.describeBlocker(check.blockedBy, placements) });
        continue;
      }

      const movableRefs = check && 'movableRoutineRefs' in check ? check.movableRoutineRefs : [];
      let evictionFailed = false;
      for (const ref of movableRefs) {
        const placement = placements[ref - 1]!;
        const entry = entryById.get(placement.entryId)!;
        const ci = this.charIndex.index(entry.characterId);
        const li = this.locIndex.index(entry.locationId);
        occupancy.clearRoutine(ref);

        const target = this.findRoutineSlot(occupancy, entry, ci, li, act.day, act.day);
        if (target !== null) {
          placement.day = target;
          placement.movedByDays = target - placement.originalDay;
          occupancy.setCharOwner(ci, target, entry.slot, ref);
          occupancy.setLocOwner(li, target, entry.slot, ref);
        } else if (entry.dropPolicy === DropPolicy.Drop) {
          placement.dropped = true;
          placement.movedByDays = 0;
        } else {
          // 迁不动且要求保留冲突:回滚占用,拒绝本次预约,交给人工处理
          occupancy.setCharOwner(ci, entry.day, entry.slot, ref);
          occupancy.setLocOwner(li, entry.day, entry.slot, ref);
          placement.conflict = true;
          rejected.push({
            clientId: act.clientId,
            reason: `角色 ${entry.characterId} 的作息「${entry.id}」无法迁移且规则为保留冲突`,
          });
          evictionFailed = true;
          break;
        }
      }
      if (evictionFailed) continue;

      occupancy.placePlayer(charIndices, locIdx, act.day, act.slot);
      accepted.push(act);
    }

    return { accepted, rejected };
  }

  private describeBlocker(owner: number, placements: RoutinePlacement[]): string {
    if (owner === OWNER_PLAYER) return '与另一行程同时段冲突';
    if (owner === OWNER_EVENT) return '该槽位已被剧情事件锁定';
    const placement = placements[owner - 1];
    return placement
      ? `角色 ${placement.characterId} 的作息「${placement.entryId}」不可移动(剧情锁定)`
      : '槽位被未知占用方阻塞';
  }

  // ==========================================================================
  // 阶段 3:事件仲裁 + 顺延状态机
  // ==========================================================================

  private scheduleEvents(
    occupancy: Occupancy,
    state: StateSnapshot,
  ): { scheduled: ScheduledEvent[]; statuses: EventStatusRow[]; candidateTries: number } {
    const { config, events } = this.data;
    const totalDays = config.totalDays;

    const runtime = new Map<string, EventRuntime>(
      events.map((def) => [
        def.id,
        {
          def,
          state: 'pending' as EventLifecycleState,
          postponeCount: 0,
          conditionEverTrue: false,
          scheduledDay: null,
          scheduledSlot: null,
        },
      ]),
    );

    // 按 earliestDay 分桶,每天只把新进窗口的事件加入活动集
    const buckets: EventDef[][] = Array.from({ length: totalDays }, () => []);
    for (const ev of events) buckets[clampDay(ev.earliestDay, totalDays)]!.push(ev);

    const active: EventRuntime[] = [];
    const scheduled: ScheduledEvent[] = [];
    const exclusiveUsed = new Set<string>();
    let candidateTries = 0;

    const baseCtx: Omit<ConditionContext, 'day' | 'eventStates'> = {
      stats: state.stats ?? {},
      flags: state.flags ?? {},
      items: state.items ?? {},
      affection: state.affection ?? {},
    };

    const eventStatesSnapshot = (): Record<string, EventLifecycleState> => {
      const out: Record<string, EventLifecycleState> = {};
      for (const [id, rt] of runtime) out[id] = rt.state;
      return out;
    };

    for (let day = 0; day < totalDays; day++) {
      // 1) 新事件进入窗口(含可重复事件重新装桶)
      for (const def of buckets[day]!) {
        const rt = runtime.get(def.id)!;
        if (rt.state === 'pending') rt.state = 'active';
        if ((rt.state === 'active' || rt.state === 'postponed') && !active.includes(rt)) {
          active.push(rt);
        }
      }

      const statesNow = eventStatesSnapshot();
      const ctx: ConditionContext = { ...baseCtx, day, eventStates: statesNow };

      // 2) 条件满足者组成候选;每天重新按全序键排序,
      //    保证高优先级/早截止事件先选槽,与事件入队顺序、历史顺延无关
      const candidates: EventRuntime[] = [];
      for (const rt of active) {
        if (rt.state !== 'active' && rt.state !== 'postponed') continue;
        if (evaluateCondition(rt.def.condition, ctx)) {
          rt.conditionEverTrue = true;
          candidates.push(rt);
        }
      }
      candidates.sort((a, b) => this.compareCandidates(a, b, day));
      const candidateSet = new Set(candidates);

      // 3) 按全序键依次尝试落位
      for (const rt of candidates) {
        candidateTries++;
        const placement = this.tryPlaceEvent(occupancy, rt.def, day, exclusiveUsed);
        if (placement) {
          rt.state = 'scheduled';
          rt.scheduledDay = placement.day;
          rt.scheduledSlot = placement.slot;
          scheduled.push({
            eventId: rt.def.id,
            day: placement.day,
            slot: placement.slot,
            locationId: rt.def.locationId,
            characterIds: [...rt.def.characterIds],
            postponeCount: rt.postponeCount,
          });
        }
      }

      // 4) 当天排上的事件在日终触发,状态立刻对后续日期可见
      for (const rt of candidates) {
        if (rt.state === 'scheduled' && rt.scheduledDay === day) {
          rt.state = 'triggered';
          if (rt.def.repeatable) this.rearm(rt, buckets, totalDays);
        }
      }

      // 5) 仍在窗口内的未排期事件走顺延/收口状态机
      const nextActive: EventRuntime[] = [];
      for (const rt of active) {
        if (rt.state !== 'active' && rt.state !== 'postponed') continue;
        if (this.advanceLifecycle(rt, day, candidateSet.has(rt), totalDays)) {
          nextActive.push(rt);
        }
      }
      active.length = 0;
      active.push(...nextActive);
    }

    // 年末兜底:仍未终结的事件按是否曾满足条件收口
    for (const rt of runtime.values()) {
      if (rt.state === 'active' || rt.state === 'postponed' || rt.state === 'pending') {
        rt.state = rt.conditionEverTrue ? 'missed' : 'expired';
      }
    }

    scheduled.sort((a, b) => a.day - b.day || a.slot - b.slot || a.eventId.localeCompare(b.eventId));
    const statuses: EventStatusRow[] = [...runtime.values()].map((rt) => ({
      eventId: rt.def.id,
      state: rt.state,
      scheduledDay: rt.scheduledDay,
      postponeCount: rt.postponeCount,
    }));

    return { scheduled, statuses, candidateTries };
  }

  /** 全序决胜键:priority 降序 → deadline 升序(EDF)→ 权重哈希 → id */
  private compareCandidates(a: EventRuntime, b: EventRuntime, day: Day): number {
    if (a.def.priority !== b.def.priority) return b.def.priority - a.def.priority;
    if (a.def.deadlineDay !== b.def.deadlineDay) return a.def.deadlineDay - b.def.deadlineDay;
    const ja = this.jitter(a.def, day);
    const jb = this.jitter(b.def, day);
    if (ja !== jb) return ja - jb;
    return a.def.id.localeCompare(b.def.id);
  }

  /**
   * 同优先级的稳定随机扰动:权重越大,扰动值期望越小、越容易排前;
   * weight = 0 表示关闭随机,完全交给 id 决胜。
   */
  private jitter(ev: EventDef, day: Day): number {
    if (ev.tieBreakWeight <= 0) return Number.MAX_SAFE_INTEGER;
    const hash01 = fnv1aHash(`${ev.id}#${day}`) / 4294967296;
    return hash01 / ev.tieBreakWeight;
  }

  private tryPlaceEvent(
    occupancy: Occupancy,
    ev: EventDef,
    day: Day,
    exclusiveUsed: Set<string>,
  ): { day: Day; slot: SlotId } | null {
    const charIndices = ev.characterIds.map((id) => this.charIndex.index(id));
    const locIdx = this.locIndex.index(ev.locationId);
    const slotOrder: SlotId[] =
      ev.slot === null
        ? Array.from({ length: this.data.config.slotsPerDay }, (_, i) => i)
        : [ev.slot];

    for (const slot of slotOrder) {
      if (!occupancy.canPlaceEvent(charIndices, locIdx, day, slot)) continue;
      if (ev.exclusiveKey) {
        const key = `${ev.exclusiveKey}|${day}|${slot}`;
        if (exclusiveUsed.has(key)) continue;
        exclusiveUsed.add(key);
      }
      occupancy.placeEvent(charIndices, locIdx, day, slot);
      return { day, slot };
    }
    return null;
  }

  /**
   * 生命周期推进。返回 true 表示事件仍在活动集中等待后续重试。
   */
  private advanceLifecycle(
    rt: EventRuntime,
    day: Day,
    condTrueToday: boolean,
    totalDays: number,
  ): boolean {
    const ev = rt.def;
    const canPostpone = ev.postpone !== PostponePolicy.None;
    const limit =
      ev.postpone === PostponePolicy.NextAvailable
        ? clampDay(ev.latestDelayDay ?? ev.deadlineDay, totalDays)
        : ev.deadlineDay;
    const maxCount = ev.maxPostponeCount ?? DEFAULT_MAX_POSTPONE;

    // 只有开了顺延策略的事件才累计顺延次数;none 策略落选后保持 active 等收口
    if (condTrueToday && canPostpone) {
      rt.postponeCount += 1;
    }

    // 顺延次数耗尽
    if (condTrueToday && canPostpone && rt.postponeCount >= maxCount) {
      rt.state = 'missed';
      return false;
    }

    if (day >= limit) {
      rt.state = rt.conditionEverTrue ? 'missed' : 'expired';
      return false;
    }

    rt.state = condTrueToday && canPostpone ? 'postponed' : 'active';
    return true;
  }

  /** 可重复事件触发后按原窗口长度重新装桶 */
  private rearm(rt: EventRuntime, buckets: EventDef[][], totalDays: number): void {
    const ev = rt.def;
    const windowLen = ev.deadlineDay - ev.earliestDay;
    const newEarliest = (rt.scheduledDay ?? 0) + 1;
    if (newEarliest >= totalDays) return;
    const newDef: EventDef = {
      ...ev,
      earliestDay: newEarliest,
      deadlineDay: Math.min(totalDays - 1, newEarliest + windowLen),
    };
    rt.def = newDef;
    rt.state = 'active';
    rt.postponeCount = 0;
    rt.conditionEverTrue = false;
    rt.scheduledDay = null;
    rt.scheduledSlot = null;
    buckets[newEarliest]!.push(newDef);
  }
}

function clampDay(day: Day, totalDays: number): Day {
  return Math.min(totalDays - 1, Math.max(0, day));
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
