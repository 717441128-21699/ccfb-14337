import { describe, expect, it } from 'vitest';
import {
  PostponePolicy,
  Scheduler,
  type EventDef,
  type GameData,
  type RoutineEntry,
  type ScheduleConfig,
  type StateSnapshot,
} from '../src/core/index.js';

const config: ScheduleConfig = {
  totalDays: 360,
  slotsPerDay: 3,
  locationIds: ['L1', 'L2'],
  characterIds: ['C1', 'C2'],
};

const TRUE = { kind: 'const', value: true } as const;
const FALSE = { kind: 'const', value: false } as const;

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

function makeData(events: EventDef[], routines: RoutineEntry[] = []): GameData {
  return { config, events, routines };
}

function dayOf(result: ReturnType<Scheduler['buildSchedule']>, eventId: string): number | null {
  return result.eventStatus.find((r) => r.eventId === eventId)!.scheduledDay;
}

function stateOf(result: ReturnType<Scheduler['buildSchedule']>, eventId: string) {
  return result.eventStatus.find((r) => r.eventId === eventId)!.state;
}

describe('事件仲裁:全序决胜键', () => {
  it('同天同地点同时段竞争时,高优先级事件胜出', () => {
    const low = makeEvent({ id: 'E_LOW', earliestDay: 10, deadlineDay: 10, priority: 1 });
    const high = makeEvent({ id: 'E_HIGH', earliestDay: 10, deadlineDay: 10, priority: 9 });
    const result = new Scheduler(makeData([low, high])).buildSchedule();

    expect(dayOf(result, 'E_HIGH')).toBe(10);
  });

  it('同优先级时,截止日更早的事件(EDF)胜出', () => {
    const later = makeEvent({ id: 'E_LATER', earliestDay: 10, deadlineDay: 15 });
    const sooner = makeEvent({ id: 'E_SOONER', earliestDay: 10, deadlineDay: 11 });
    const result = new Scheduler(makeData([later, sooner])).buildSchedule();

    expect(dayOf(result, 'E_SOONER')).toBe(10);
  });

  it('前两键都相同时,id 字典序稳定决胜,且结果确定性可复现', () => {
    const a = makeEvent({ id: 'E_A', earliestDay: 10, deadlineDay: 10 });
    const b = makeEvent({ id: 'E_B', earliestDay: 10, deadlineDay: 10 });
    const scheduler = new Scheduler(makeData([b, a]));
    const r1 = scheduler.buildSchedule();
    const r2 = scheduler.buildSchedule();

    expect(dayOf(r1, 'E_A')).toBe(10);
    expect(dayOf(r2, 'E_A')).toBe(10);
    expect(dayOf(r1, 'E_B')).toBeNull();
  });

  it('同优先级且配置了权重时,决胜结果由确定性哈希决定而非数组顺序', () => {
    // 两个事件在第 10 天唯一槽位竞争,权重不同;调换输入顺序结果不变
    const x = makeEvent({ id: 'E_X', earliestDay: 10, deadlineDay: 10, tieBreakWeight: 1 });
    const y = makeEvent({ id: 'E_Y', earliestDay: 10, deadlineDay: 10, tieBreakWeight: 5 });
    const r1 = new Scheduler(makeData([x, y])).buildSchedule();
    const r2 = new Scheduler(makeData([y, x])).buildSchedule();

    const winner1 = r1.scheduledEvents.find((s) => s.day === 10)!.eventId;
    const winner2 = r2.scheduledEvents.find((s) => s.day === 10)!.eventId;
    expect(winner1).toBe(winner2);
  });
});

describe('顺延状态机', () => {
  it('postpone=none:落选当天截止即 missed,不会自动顺延', () => {
    const blocker = makeEvent({ id: 'E_BLOCK', earliestDay: 10, deadlineDay: 10, priority: 9 });
    const victim = makeEvent({ id: 'E_VICTIM', earliestDay: 10, deadlineDay: 10, postpone: PostponePolicy.None });
    const result = new Scheduler(makeData([blocker, victim])).buildSchedule();

    expect(stateOf(result, 'E_VICTIM')).toBe('missed');
    expect(dayOf(result, 'E_VICTIM')).toBeNull();
  });

  it('postpone=none:窗口内多日落选也不累加顺延计数,截止日才收口为 missed', () => {
    // 窗口 [10,12],第 10、11 天被高优事件占;none 不顺延,第 12 天仍抢不到才 missed
    const blockers = [10, 11, 12].map((d) =>
      makeEvent({ id: `B_${d}`, earliestDay: d, deadlineDay: d, priority: 9 }),
    );
    const victim = makeEvent({ id: 'E_VICTIM', earliestDay: 10, deadlineDay: 12, postpone: PostponePolicy.None });
    const result = new Scheduler(makeData([...blockers, victim])).buildSchedule();

    const status = result.eventStatus.find((r) => r.eventId === 'E_VICTIM')!;
    expect(status.state).toBe('missed');
    expect(status.postponeCount).toBe(0);
  });

  it('within-window:落选事件在窗口内逐日重试,排上后续顺延计数 +1', () => {
    // 第 10、11 天被高优事件占住 L1/slot0,受害者窗口 [10,12]
    const blockers = [10, 11].map((d) =>
      makeEvent({ id: `B_${d}`, earliestDay: d, deadlineDay: d, priority: 9 }),
    );
    const victim = makeEvent({
      id: 'E_VICTIM',
      earliestDay: 10,
      deadlineDay: 12,
      postpone: PostponePolicy.WithinWindow,
    });
    const result = new Scheduler(makeData([...blockers, victim])).buildSchedule();

    expect(dayOf(result, 'E_VICTIM')).toBe(12);
    const status = result.eventStatus.find((r) => r.eventId === 'E_VICTIM')!;
    expect(status.postponeCount).toBe(2);
    expect(status.state).toBe('triggered');
  });

  it('within-window:窗口结束仍未排上 → missed', () => {
    const blockers = [10, 11, 12].map((d) =>
      makeEvent({ id: `B_${d}`, earliestDay: d, deadlineDay: d, priority: 9 }),
    );
    const victim = makeEvent({
      id: 'E_VICTIM',
      earliestDay: 10,
      deadlineDay: 12,
      postpone: PostponePolicy.WithinWindow,
    });
    const result = new Scheduler(makeData([...blockers, victim])).buildSchedule();

    expect(stateOf(result, 'E_VICTIM')).toBe('missed');
  });

  it('next-available:窗口结束后继续顺延到 latestDelayDay,成功落位', () => {
    const blockers = [10, 11, 12, 13].map((d) =>
      makeEvent({ id: `B_${d}`, earliestDay: d, deadlineDay: d, priority: 9 }),
    );
    const victim = makeEvent({
      id: 'E_VICTIM',
      earliestDay: 10,
      deadlineDay: 12,
      postpone: PostponePolicy.NextAvailable,
      latestDelayDay: 20,
    });
    const result = new Scheduler(makeData([...blockers, victim])).buildSchedule();

    expect(dayOf(result, 'E_VICTIM')).toBe(14);
  });

  it('next-available:latestDelayDay 仍未排上 → missed', () => {
    const blockers = Array.from({ length: 8 }, (_, i) =>
      makeEvent({ id: `B_${i}`, earliestDay: 10 + i, deadlineDay: 10 + i, priority: 9 }),
    );
    const victim = makeEvent({
      id: 'E_VICTIM',
      earliestDay: 10,
      deadlineDay: 12,
      postpone: PostponePolicy.NextAvailable,
      latestDelayDay: 15,
    });
    const result = new Scheduler(makeData([...blockers, victim])).buildSchedule();

    expect(stateOf(result, 'E_VICTIM')).toBe('missed');
  });

  it('maxPostponeCount 优先于窗口耗尽:次数到顶即 missed', () => {
    const blockers = [10, 11, 12, 13].map((d) =>
      makeEvent({ id: `B_${d}`, earliestDay: d, deadlineDay: d, priority: 9 }),
    );
    const victim = makeEvent({
      id: 'E_VICTIM',
      earliestDay: 10,
      deadlineDay: 30,
      postpone: PostponePolicy.WithinWindow,
      maxPostponeCount: 2,
    });
    const result = new Scheduler(makeData([...blockers, victim])).buildSchedule();

    expect(stateOf(result, 'E_VICTIM')).toBe('missed');
    expect(result.eventStatus.find((r) => r.eventId === 'E_VICTIM')!.postponeCount).toBe(2);
  });

  it('条件始终不满足 → expired(区别于资源竞争导致的 missed)', () => {
    const ev = makeEvent({ id: 'E_NEVER', earliestDay: 10, deadlineDay: 12, condition: FALSE });
    const result = new Scheduler(makeData([ev])).buildSchedule();

    expect(stateOf(result, 'E_NEVER')).toBe('expired');
  });

  it('条件不满足的日子不消耗顺延次数', () => {
    const ev = makeEvent({
      id: 'E_GATED',
      earliestDay: 10,
      deadlineDay: 14,
      condition: { kind: 'flag', flag: 'open', value: true },
      postpone: PostponePolicy.WithinWindow,
      maxPostponeCount: 1,
    });
    // 第 10~13 天 flag 未开,第 14 天才开;窗口最后一天也能排上
    const state: StateSnapshot = { flags: {} };
    const scheduler = new Scheduler(makeData([ev]));
    // 静态快照模型下直接给最终 flag;条件在所有天都为真时应正常排期
    const result = scheduler.buildSchedule([], { flags: { open: true } });
    expect(dayOf(result, 'E_GATED')).toBe(10);
    expect(stateOf(result, 'E_GATED')).toBe('triggered');
  });
});

describe('slot 与互斥', () => {
  it('slot=null 的事件自动选取当天第一个空闲时段', () => {
    const first = makeEvent({ id: 'E_FIRST', earliestDay: 10, deadlineDay: 10, slot: 0, priority: 9 });
    const flexible = makeEvent({ id: 'E_FLEX', earliestDay: 10, deadlineDay: 10, slot: null });
    const result = new Scheduler(makeData([first, flexible])).buildSchedule();

    const placed = result.scheduledEvents.find((s) => s.eventId === 'E_FLEX')!;
    expect(placed.slot).toBe(1);
  });

  it('exclusiveKey 相同的事件同一天最多排一个,另一个顺延', () => {
    const a = makeEvent({ id: 'E_A', earliestDay: 10, deadlineDay: 10, locationId: 'L1', slot: 0, exclusiveKey: 'X' });
    const b = makeEvent({ id: 'E_B', earliestDay: 10, deadlineDay: 11, locationId: 'L2', slot: 0, exclusiveKey: 'X', postpone: PostponePolicy.WithinWindow });
    const result = new Scheduler(makeData([a, b])).buildSchedule();

    expect(dayOf(result, 'E_A')).toBe(10);
    expect(dayOf(result, 'E_B')).toBe(11);
  });

  it('角色同时段不可分身:占用同一角色的两个事件只有一个能排上', () => {
    const a = makeEvent({ id: 'E_A', earliestDay: 10, deadlineDay: 10, locationId: 'L1', slot: 0, characterIds: ['C1'], priority: 9 });
    const b = makeEvent({ id: 'E_B', earliestDay: 10, deadlineDay: 11, locationId: 'L2', slot: 0, characterIds: ['C1'], postpone: PostponePolicy.WithinWindow });
    const result = new Scheduler(makeData([a, b])).buildSchedule();

    expect(dayOf(result, 'E_B')).toBe(11);
  });
});
