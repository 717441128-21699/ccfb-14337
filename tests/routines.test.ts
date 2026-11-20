import { describe, expect, it } from 'vitest';
import {
  DropPolicy,
  MovePolicy,
  PostponePolicy,
  Scheduler,
  type EventDef,
  type GameData,
  type PlayerActivity,
  type RoutineEntry,
  type ScheduleConfig,
} from '../src/core/index.js';

const config: ScheduleConfig = {
  totalDays: 360,
  slotsPerDay: 3,
  locationIds: ['L1', 'L2', 'L3'],
  characterIds: ['C1', 'C2'],
};

const TRUE = { kind: 'const', value: true } as const;

function routine(partial: Partial<RoutineEntry> & Pick<RoutineEntry, 'id' | 'characterId' | 'day'>): RoutineEntry {
  return {
    slot: 0,
    locationId: 'L1',
    movable: true,
    movePolicy: MovePolicy.Nearest,
    maxBackwardDays: 7,
    maxForwardDays: 7,
    dropPolicy: DropPolicy.Drop,
    ...partial,
  };
}

function makeEvent(partial: Partial<EventDef> & Pick<EventDef, 'id' | 'earliestDay' | 'deadlineDay'>): EventDef {
  return {
    title: partial.id,
    slot: 0,
    locationId: 'L1',
    characterIds: [],
    condition: TRUE,
    priority: 0,
    tieBreakWeight: 0,
    postpone: PostponePolicy.None,
    ...partial,
  };
}

function makeData(events: EventDef[] = [], routines: RoutineEntry[] = []): GameData {
  return { config, events, routines };
}

function placementOf(result: ReturnType<Scheduler['buildSchedule']>, entryId: string) {
  return result.routinePlacements.find((p) => p.entryId === entryId)!;
}

describe('角色作息迁移', () => {
  it('nearest 策略:被挤后挪到距离最近的空档(先正向后反向)', () => {
    // 第 9、11 天同角色同时段都被占,正反向距离相等时按"先正向"取第 12 天
    const r0 = routine({ id: 'R0', characterId: 'C1', day: 10 });
    const rMinus1 = routine({ id: 'R_M1', characterId: 'C1', day: 9 });
    const r1 = routine({ id: 'R1', characterId: 'C1', day: 11 });
    const appointment: PlayerActivity = {
      clientId: 'A1',
      day: 10,
      slot: 0,
      locationId: 'L1',
      characterIds: ['C1'],
    };
    const result = new Scheduler(makeData([], [r0, rMinus1, r1])).buildSchedule([appointment]);

    const moved = placementOf(result, 'R0');
    expect(moved.day).toBe(12);
    expect(moved.movedByDays).toBe(2);
    expect(moved.dropped).toBe(false);
  });

  it('forward 策略只向后找,backward 策略只向前找', () => {
    const base: RoutineEntry[] = [
      routine({ id: 'RF', characterId: 'C1', day: 10, movePolicy: MovePolicy.Forward }),
      routine({ id: 'RB', characterId: 'C2', day: 10, movePolicy: MovePolicy.Backward, locationId: 'L2' }),
    ];
    const acts: PlayerActivity[] = [
      { clientId: 'AF', day: 10, slot: 0, locationId: 'L1', characterIds: ['C1'] },
      { clientId: 'AB', day: 10, slot: 0, locationId: 'L2', characterIds: ['C2'] },
    ];
    const result = new Scheduler(makeData([], base)).buildSchedule(acts);

    expect(placementOf(result, 'RF').day).toBe(11);
    expect(placementOf(result, 'RB').day).toBe(9);
  });

  it('迁移窗口内没有空档 + drop 策略 → 丢弃并在结果中标记', () => {
    // 占满第 8~13 天的角色槽,迁移窗口 7 天内无处可去
    const blockers: RoutineEntry[] = [];
    for (let d = 3; d <= 17; d++) {
      if (d === 10) continue;
      blockers.push(routine({ id: `RB_${d}`, characterId: 'C1', day: d }));
    }
    const victim = routine({ id: 'RV', characterId: 'C1', day: 10, maxBackwardDays: 2, maxForwardDays: 2, dropPolicy: DropPolicy.Drop });
    const appointment: PlayerActivity = { clientId: 'A1', day: 10, slot: 0, locationId: 'L1', characterIds: ['C1'] };

    const result = new Scheduler(makeData([], [...blockers, victim])).buildSchedule([appointment]);
    const p = placementOf(result, 'RV');
    expect(p.dropped).toBe(true);
    expect(result.stats.routinesDropped).toBeGreaterThanOrEqual(1);
  });

  it('keep-conflict 策略迁不动时拒绝预约而不是静默丢弃', () => {
    const blockers: RoutineEntry[] = [];
    for (let d = 8; d <= 12; d++) {
      if (d === 10) continue;
      blockers.push(routine({ id: `RB_${d}`, characterId: 'C1', day: d }));
    }
    const victim = routine({
      id: 'RV',
      characterId: 'C1',
      day: 10,
      maxBackwardDays: 1,
      maxForwardDays: 1,
      dropPolicy: DropPolicy.KeepConflict,
    });
    const appointment: PlayerActivity = { clientId: 'A1', day: 10, slot: 0, locationId: 'L1', characterIds: ['C1'] };

    const result = new Scheduler(makeData([], [...blockers, victim])).buildSchedule([appointment]);
    expect(result.rejectedActivities.map((r) => r.clientId)).toContain('A1');
    expect(placementOf(result, 'RV').conflict).toBe(true);
  });

  it('不可移动的作息(剧情锁定)直接挡住玩家预约', () => {
    const locked = routine({ id: 'R_LOCK', characterId: 'C1', day: 10, movable: false });
    const appointment: PlayerActivity = { clientId: 'A1', day: 10, slot: 0, locationId: 'L1', characterIds: ['C1'] };

    const result = new Scheduler(makeData([], [locked])).buildSchedule([appointment]);
    expect(result.rejectedActivities).toHaveLength(1);
    expect(result.rejectedActivities[0]!.reason).toContain('不可移动');
  });

  it('两个玩家行程同角色同时段冲突,后一个被拒绝', () => {
    const acts: PlayerActivity[] = [
      { clientId: 'A1', day: 10, slot: 0, locationId: 'L1', characterIds: ['C1'] },
      { clientId: 'A2', day: 10, slot: 0, locationId: 'L2', characterIds: ['C1'] },
    ];
    const result = new Scheduler(makeData()).buildSchedule(acts);
    expect(result.rejectedActivities.map((r) => r.clientId)).toEqual(['A2']);
  });
});

describe('级联重排', () => {
  it('玩家预约改变角色占用后,依赖该角色的事件在窗口内顺延重排', () => {
    // 事件需要 C1,窗口 [10,12];玩家第 10 天在 L2 约走 C1,事件顺延到第 11 天
    const ev = makeEvent({
      id: 'E_FOLLOW',
      earliestDay: 10,
      deadlineDay: 12,
      characterIds: ['C1'],
      postpone: PostponePolicy.WithinWindow,
    });
    const appointment: PlayerActivity = { clientId: 'A1', day: 10, slot: 0, locationId: 'L2', characterIds: ['C1'] };

    const withoutAppt = new Scheduler(makeData([ev], [])).buildSchedule([]);
    const withAppt = new Scheduler(makeData([ev], [])).buildSchedule([appointment]);

    expect(withoutAppt.eventStatus.find((r) => r.eventId === 'E_FOLLOW')!.scheduledDay).toBe(10);
    expect(withAppt.eventStatus.find((r) => r.eventId === 'E_FOLLOW')!.scheduledDay).toBe(11);
  });

  it('玩家预约挤走可移动作息,作息迁移到最近空档', () => {
    // 作息 R0 在 L2/C1/第10天,forward 迁移;预约把它挤到第 11 天
    const r0 = routine({ id: 'R0', characterId: 'C1', day: 10, locationId: 'L2', movePolicy: MovePolicy.Forward });
    const appointment: PlayerActivity = { clientId: 'A1', day: 10, slot: 0, locationId: 'L2', characterIds: ['C1'] };

    const result = new Scheduler(makeData([], [r0])).buildSchedule([appointment]);
    const moved = placementOf(result, 'R0');
    expect(moved.day).toBe(11);
    expect(moved.movedByDays).toBe(1);
    expect(result.rejectedActivities).toHaveLength(0);
  });

  it('applyActivityPatch:增量编辑后返回合并行程与新队列,移除行程后槽位释放', () => {
    const scheduler = new Scheduler(makeData());
    const a1: PlayerActivity = { clientId: 'A1', day: 10, slot: 0, locationId: 'L1', characterIds: ['C1'] };
    const a2: PlayerActivity = { clientId: 'A2', day: 11, slot: 0, locationId: 'L1', characterIds: ['C1'] };

    const first = scheduler.applyActivityPatch([], { upserted: [a1, a2], removedClientIds: [] });
    expect(first.activities).toHaveLength(2);
    expect(first.result.rejectedActivities).toHaveLength(0);

    const second = scheduler.applyActivityPatch(first.activities, { upserted: [], removedClientIds: ['A1'] });
    expect(second.activities.map((a) => a.clientId)).toEqual(['A2']);
  });

  it('重排是确定性的:同样输入多次构建结果完全一致', () => {
    const routines = [
      routine({ id: 'R1', characterId: 'C1', day: 10 }),
      routine({ id: 'R2', characterId: 'C1', day: 11 }),
    ];
    const events = [
      makeEvent({ id: 'E1', earliestDay: 10, deadlineDay: 12, postpone: PostponePolicy.WithinWindow }),
      makeEvent({ id: 'E2', earliestDay: 10, deadlineDay: 10, priority: 5 }),
    ];
    const appointment: PlayerActivity = { clientId: 'A1', day: 10, slot: 0, locationId: 'L1', characterIds: ['C1'] };
    const scheduler = new Scheduler(makeData(events, routines));

    const r1 = scheduler.buildSchedule([appointment]);
    const r2 = scheduler.buildSchedule([appointment]);
    expect(JSON.stringify(r1.scheduledEvents)).toBe(JSON.stringify(r2.scheduledEvents));
    expect(JSON.stringify(r1.routinePlacements)).toBe(JSON.stringify(r2.routinePlacements));
  });
});
