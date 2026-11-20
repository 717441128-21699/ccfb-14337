import { describe, expect, it } from 'vitest';
import { Scheduler, generateGameData, validateGameData, type PlayerActivity } from '../src/core/index.js';

/** 取多次运行的中位数,规避单次 GC/抖动噪声 */
function medianMs(runs: number, fn: () => void): number {
  const samples: number[] = [];
  // 预热一次(JIT、隐藏类稳定)
  fn();
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

describe('性能验收(360 天全年规模)', () => {
  const data = generateGameData({ eventCount: 1000, characterCount: 8, locationCount: 10 });

  it('生成的测试表本身通过静态校验', () => {
    expect(data.events).toHaveLength(1000);
    expect(data.config.totalDays).toBe(360);
    const errors = validateGameData(data).filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('1000 条事件载入后排出全年事件队列 < 1000ms', () => {
    const scheduler = new Scheduler(data);
    const elapsed = medianMs(7, () => scheduler.buildSchedule());

    const result = scheduler.buildSchedule();
    // 功能性 sanity check:结果覆盖全部事件且日期合法
    expect(result.eventStatus).toHaveLength(1000);
    for (const row of result.eventStatus) {
      if (row.scheduledDay !== null) {
        expect(row.scheduledDay).toBeGreaterThanOrEqual(0);
        expect(row.scheduledDay).toBeLessThan(360);
      }
    }
    // 排上的事件之间不得有同资源同时段重叠
    const keys = new Set<string>();
    for (const s of result.scheduledEvents) {
      const locKey = `loc:${s.locationId}|${s.day}|${s.slot}`;
      expect(keys.has(locKey)).toBe(false);
      keys.add(locKey);
      for (const c of s.characterIds) {
        const cKey = `char:${c}|${s.day}|${s.slot}`;
        expect(keys.has(cKey)).toBe(false);
        keys.add(cKey);
      }
    }

    console.log(`[perf] 1000 事件全年排期中位耗时: ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(1000);
  });

  it('全部角色全年作息重排 < 200ms(无玩家行程的基线重算)', () => {
    const scheduler = new Scheduler(data);
    const elapsed = medianMs(9, () => scheduler.buildSchedule());

    console.log(
      `[perf] 全年作息(${data.routines.length} 条)重排中位耗时: ${elapsed.toFixed(2)}ms,` +
      `迁移 ${scheduler.buildSchedule().stats.routinesMoved} 条`,
    );
    expect(elapsed).toBeLessThan(200);
  });

  it('玩家预约触发的增量重排(含作息迁移 + 事件级联) < 200ms', () => {
    const scheduler = new Scheduler(data);
    // 构造 40 条覆盖全年的玩家预约,每条都预约不同角色,制造真实迁移压力
    const activities: PlayerActivity[] = Array.from({ length: 40 }, (_, i) => ({
      clientId: `A_${i}`,
      day: Math.floor((i * 360) / 40),
      slot: i % data.config.slotsPerDay,
      locationId: data.config.locationIds[i % data.config.locationIds.length]!,
      characterIds: [data.config.characterIds[i % data.config.characterIds.length]!],
    }));

    const elapsed = medianMs(9, () => scheduler.buildSchedule(activities));
    const result = scheduler.buildSchedule(activities);
    console.log(
      `[perf] 40 条预约增量重排中位耗时: ${elapsed.toFixed(2)}ms,` +
      `作息迁移 ${result.stats.routinesMoved} 条、丢弃 ${result.stats.routinesDropped} 条、` +
      `拒绝 ${result.rejectedActivities.length} 条`,
    );
    expect(elapsed).toBeLessThan(200);
  });
});
