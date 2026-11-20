import { describe, expect, it } from 'vitest';
import { evaluateCondition } from '../src/core/condition.js';
import { validateActivities, validateGameData } from '../src/core/validation.js';
import {
  PostponePolicy,
  type ConditionContext,
  type EventDef,
  type GameData,
  type RoutineEntry,
} from '../src/core/index.js';

const baseConfig = {
  totalDays: 360,
  slotsPerDay: 3,
  locationIds: ['L1', 'L2'],
  characterIds: ['C1', 'C2'],
};

const TRUE = { kind: 'const', value: true } as const;

function evt(partial: Partial<EventDef> & { id: string }): EventDef {
  return {
    title: partial.id,
    earliestDay: 0,
    deadlineDay: 10,
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

function rt(partial: Partial<RoutineEntry> & { id: string }): RoutineEntry {
  return {
    characterId: 'C1',
    day: 0,
    slot: 0,
    locationId: 'L1',
    movable: true,
    movePolicy: 'nearest' as RoutineEntry['movePolicy'],
    dropPolicy: 'drop' as RoutineEntry['dropPolicy'],
    ...partial,
  };
}

describe('条件解释器', () => {
  const ctx: ConditionContext = {
    day: 7,
    stats: { energy: 60, money: 0 },
    flags: { chapter_2_open: true },
    items: { potion: 3 },
    affection: { C1: 80 },
    eventStates: { E1: 'triggered' },
  };

  it('all/any/not 组合语义正确', () => {
    expect(evaluateCondition({ kind: 'all', of: [TRUE, TRUE] }, ctx)).toBe(true);
    expect(evaluateCondition({ kind: 'all', of: [TRUE, { kind: 'const', value: false }] }, ctx)).toBe(false);
    expect(evaluateCondition({ kind: 'any', of: [{ kind: 'const', value: false }, TRUE] }, ctx)).toBe(true);
    expect(evaluateCondition({ kind: 'not', expr: TRUE }, ctx)).toBe(false);
  });

  it('stat / flag / item / affection 比较', () => {
    expect(evaluateCondition({ kind: 'stat', stat: 'energy', op: '>=', value: 50 }, ctx)).toBe(true);
    expect(evaluateCondition({ kind: 'stat', stat: 'energy', op: '<', value: 50 }, ctx)).toBe(false);
    expect(evaluateCondition({ kind: 'flag', flag: 'chapter_2_open', value: true }, ctx)).toBe(true);
    expect(evaluateCondition({ kind: 'item', item: 'potion', op: '==', value: 3 }, ctx)).toBe(true);
    expect(evaluateCondition({ kind: 'affection', character: 'C1', op: '>=', value: 90 }, ctx)).toBe(false);
  });

  it('缺失的状态变量按零值处理', () => {
    expect(evaluateCondition({ kind: 'stat', stat: 'missing', op: '==', value: 0 }, ctx)).toBe(true);
    expect(evaluateCondition({ kind: 'flag', flag: 'missing', value: false }, ctx)).toBe(true);
  });

  it('weekday 按六天工作制取模', () => {
    expect(evaluateCondition({ kind: 'weekday', days: [1] }, ctx)).toBe(true); // 7 % 6 = 1
    expect(evaluateCondition({ kind: 'weekday', days: [0] }, ctx)).toBe(false);
  });

  it('eventState 条件', () => {
    expect(evaluateCondition({ kind: 'eventState', event: 'E1', state: 'triggered' }, ctx)).toBe(true);
    expect(evaluateCondition({ kind: 'eventState', event: 'E2', state: 'pending' }, ctx)).toBe(true);
  });
});

describe('事件表校验', () => {
  it('干净数据没有 error', () => {
    const data: GameData = {
      config: baseConfig,
      events: [evt({ id: 'E1' }), evt({ id: 'E2', earliestDay: 5, deadlineDay: 8 })],
      routines: [rt({ id: 'R1' }), rt({ id: 'R2', characterId: 'C2', locationId: 'L2' })],
    };
    const issues = validateGameData(data);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('捕获重复 id、越界日期、悬空地点/角色引用', () => {
    const data: GameData = {
      config: baseConfig,
      events: [
        evt({ id: 'E1' }),
        evt({ id: 'E1', earliestDay: 400, locationId: 'NOPE', characterIds: ['GHOST'] }),
      ],
      routines: [],
    };
    const issues = validateGameData(data);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('EVENT_ID_DUP');
    expect(codes).toContain('EVENT_DAY_RANGE');
    expect(codes).toContain('EVENT_LOC_UNKNOWN');
    expect(codes).toContain('EVENT_CHAR_UNKNOWN');
  });

  it('捕获反转窗口与非法顺延下限', () => {
    const data: GameData = {
      config: baseConfig,
      events: [
        evt({ id: 'E1', earliestDay: 20, deadlineDay: 10 }),
        evt({ id: 'E2', postpone: PostponePolicy.NextAvailable, earliestDay: 0, deadlineDay: 10, latestDelayDay: 5 }),
      ],
      routines: [],
    };
    const codes = validateGameData(data).map((i) => i.code);
    expect(codes).toContain('EVENT_WINDOW_REVERSED');
    expect(codes).toContain('EVENT_DELAY_LIMIT');
  });

  it('捕获事件依赖环与悬空事件引用', () => {
    const data: GameData = {
      config: baseConfig,
      events: [
        evt({ id: 'E1', condition: { kind: 'eventState', event: 'E2', state: 'triggered' } }),
        evt({ id: 'E2', condition: { kind: 'eventState', event: 'E1', state: 'triggered' } }),
        evt({ id: 'E3', condition: { kind: 'eventState', event: 'GHOST', state: 'triggered' } }),
      ],
      routines: [],
    };
    const issues = validateGameData(data);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('COND_CYCLE');
    expect(codes).toContain('COND_EVENT_DANGLING');
  });

  it('同地点同时段窗口重叠给出 contention 提示(info,不阻断)', () => {
    const data: GameData = {
      config: baseConfig,
      events: [
        evt({ id: 'E1', earliestDay: 5, deadlineDay: 10 }),
        evt({ id: 'E2', earliestDay: 8, deadlineDay: 12 }),
      ],
      routines: [],
    };
    const issues = validateGameData(data);
    expect(issues.some((i) => i.code === 'EVENT_CONTENTION')).toBe(true);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('作息冲突产生 warning 而非 error', () => {
    const data: GameData = {
      config: baseConfig,
      events: [],
      routines: [rt({ id: 'R1' }), rt({ id: 'R2' })],
    };
    const issues = validateGameData(data);
    expect(issues.some((i) => i.code === 'ROUTINE_CHAR_OVERLAP' && i.severity === 'warning')).toBe(true);
  });
});

describe('玩家行程校验', () => {
  it('重复 clientId 与越界时段报错', () => {
    const issues = validateActivities(
      [
        { clientId: 'A1', day: 0, slot: 0, locationId: 'L1', characterIds: [] },
        { clientId: 'A1', day: 1, slot: 99, locationId: 'L1', characterIds: [] },
      ],
      baseConfig,
    );
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('ACT_ID_DUP');
    expect(codes).toContain('ACT_SLOT_RANGE');
  });
});
