import {
  DropPolicy,
  MovePolicy,
  PostponePolicy,
  TOTAL_DAYS,
  type ConditionExpr,
  type EventDef,
  type GameData,
  type RoutineEntry,
  type ScheduleConfig,
} from './types.js';

/** 确定性伪随机数生成器(mulberry32),保证同种子生成同一张表 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }
}

export interface GeneratorOptions {
  seed?: number;
  eventCount?: number;
  characterCount?: number;
  locationCount?: number;
  slotsPerDay?: number;
  /** 每个角色生成多少条作息,默认 120 */
  routinesPerCharacter?: number;
}

export const DEFAULT_GENERATOR_OPTIONS: Required<GeneratorOptions> = {
  seed: 20261121,
  eventCount: 1000,
  characterCount: 8,
  locationCount: 10,
  slotsPerDay: 4,
  routinesPerCharacter: 120,
};

/**
 * 按一年 360 天的真实规模生成测试事件表。
 * 刻意制造:同地点同时段窗口重叠(测仲裁)、窗口尾事件(测顺延)、
 * 互斥组、事件依赖链、可重复事件、各种迁移/丢弃策略组合。
 */
export function generateGameData(options: GeneratorOptions = {}): GameData {
  const opts = { ...DEFAULT_GENERATOR_OPTIONS, ...options };
  const rng = new SeededRandom(opts.seed);

  const characterIds = Array.from({ length: opts.characterCount }, (_, i) => `char_${pad(i + 1)}`);
  const locationIds = Array.from({ length: opts.locationCount }, (_, i) => `loc_${pad(i + 1)}`);

  const config: ScheduleConfig = {
    totalDays: TOTAL_DAYS,
    slotsPerDay: opts.slotsPerDay,
    locationIds,
    characterIds,
  };

  const events: EventDef[] = [];
  const previousIds: string[] = [];

  for (let i = 0; i < opts.eventCount; i++) {
    const id = `evt_${pad(i + 1, 4)}`;
    const earliest = rng.int(0, TOTAL_DAYS - 20);
    const windowLen = rng.int(1, 25);
    const deadline = Math.min(TOTAL_DAYS - 1, earliest + windowLen);
    const fixedSlot = rng.bool(0.7) ? rng.int(0, opts.slotsPerDay - 1) : null;
    const locationId = rng.pick(locationIds);
    const charCount = rng.bool(0.6) ? rng.int(1, Math.min(3, opts.characterCount)) : 0;
    const characterIdsForEvent = sample(characterIds, charCount, rng);

    const policies = [PostponePolicy.None, PostponePolicy.WithinWindow, PostponePolicy.NextAvailable];
    const postpone = rng.pick(policies);
    const condition = buildCondition(rng, previousIds, characterIdsForEvent, i);

    const ev: EventDef = {
      id,
      title: `测试事件 ${i + 1}`,
      earliestDay: earliest,
      deadlineDay: deadline,
      slot: fixedSlot,
      locationId,
      characterIds: characterIdsForEvent,
      condition,
      priority: rng.int(0, 9),
      tieBreakWeight: rng.bool(0.4) ? rng.int(1, 5) : 0,
      postpone,
      maxPostponeCount: rng.int(4, 20),
      note: `seed=${opts.seed}`,
    };
    if (postpone === PostponePolicy.NextAvailable && rng.bool(0.7)) {
      ev.latestDelayDay = Math.min(TOTAL_DAYS - 1, deadline + rng.int(1, 15));
    }
    if (rng.bool(0.08)) ev.exclusiveKey = `chain_${rng.int(1, 12)}`;
    if (rng.bool(0.05)) ev.repeatable = true;

    events.push(ev);
    previousIds.push(id);
  }

  const routines: RoutineEntry[] = [];
  const movePolicies = [MovePolicy.Nearest, MovePolicy.Forward, MovePolicy.Backward];
  const dropPolicies = [DropPolicy.Drop, DropPolicy.KeepConflict];
  let routineSeq = 0;
  for (const charId of characterIds) {
    for (let k = 0; k < opts.routinesPerCharacter; k++) {
      routineSeq++;
      const movable = rng.bool(0.85);
      routines.push({
        id: `rt_${pad(routineSeq, 4)}`,
        characterId: charId,
        day: rng.int(0, TOTAL_DAYS - 1),
        slot: rng.int(0, opts.slotsPerDay - 1),
        locationId: rng.pick(locationIds),
        movable,
        movePolicy: rng.pick(movePolicies),
        maxBackwardDays: rng.int(3, 10),
        maxForwardDays: rng.int(3, 10),
        dropPolicy: rng.pick(dropPolicies),
      });
    }
  }

  return { config, events, routines };
}

function buildCondition(
  rng: SeededRandom,
  previousIds: readonly string[],
  characterIds: readonly string[],
  index: number,
): ConditionExpr {
  const parts: ConditionExpr[] = [];
  if (rng.bool(0.5)) {
    parts.push({ kind: 'stat', stat: rng.pick(['energy', 'money', 'fame', 'stamina']), op: '>=', value: rng.int(0, 80) });
  }
  if (rng.bool(0.4)) {
    parts.push({ kind: 'flag', flag: `chapter_${rng.int(1, 6)}_open`, value: true });
  }
  if (characterIds.length > 0 && rng.bool(0.4)) {
    parts.push({ kind: 'affection', character: characterIds[0]!, op: '>=', value: rng.int(0, 60) });
  }
  if (previousIds.length > 10 && rng.bool(0.15)) {
    // 只依赖更早的事件,天然无环
    const dep = previousIds[rng.int(0, previousIds.length - 6)]!;
    parts.push({ kind: 'eventState', event: dep, state: 'triggered' });
  }
  if (rng.bool(0.25)) {
    parts.push({ kind: 'weekday', days: [rng.int(0, 5)] });
  }
  if (parts.length === 0) return { kind: 'const', value: true };
  if (parts.length === 1) return parts[0]!;
  return { kind: 'all', of: parts };
}

function sample<T>(items: readonly T[], count: number, rng: SeededRandom): T[] {
  const pool = [...items];
  const out: T[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = rng.int(0, pool.length - 1);
    out.push(pool.splice(idx, 1)[0]!);
  }
  return out;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}
