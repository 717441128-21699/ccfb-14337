// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DropPolicy, generateGameData, MovePolicy, PostponePolicy } from '../src/core/index.js';
import type { EditorStore } from '../src/editor/state.js';

describe('编辑页冒烟测试(happy-dom)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    localStorage.clear();
    vi.resetModules();
  });

  async function mountFresh(): Promise<EditorStore> {
    const { initEditor } = await import('../src/editor/app.js');
    const root = document.querySelector<HTMLDivElement>('#app')!;
    return initEditor(root);
  }

  it('首次挂载渲染顶栏、校验条与事件表,默认示例数据可排程', async () => {
    const store = await mountFresh();
    expect(document.querySelector('.topbar h1')?.textContent).toContain('调度台');
    expect(document.querySelectorAll('#event-rows tr').length).toBeGreaterThan(0);
    expect(store.state.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(store.runScheduler()).toBeNull();
    expect(store.state.result).not.toBeNull();
    expect(store.state.result!.stats.totalEvents).toBe(2);
  });

  it('一键载入 1000 事件的 360 天测试表:零 error 且排程成功', async () => {
    const store = await mountFresh();
    const data = generateGameData({ eventCount: 1000 });
    store.replaceAll(data, []);

    expect(store.state.data.events).toHaveLength(1000);
    expect(store.state.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(store.runScheduler()).toBeNull();
    const r = store.state.result!;
    expect(r.eventStatus).toHaveLength(1000);
    for (const row of r.eventStatus) {
      expect(['triggered', 'missed', 'expired', 'scheduled', 'active', 'postponed', 'pending']).toContain(row.state);
    }
  });

  it('切到全年队列面板能看到统计卡片与当日视图', async () => {
    const store = await mountFresh();
    store.runScheduler();
    (document.querySelector('[data-tab="schedule"]') as HTMLButtonElement).click();

    expect(document.querySelector('.stats-grid')?.textContent).toContain('事件总数');
    expect(document.querySelector('#day-view .day-table')).not.toBeNull();
    expect(document.querySelectorAll('#status-rows tr').length).toBeGreaterThan(0);
  });

  it('编辑事件制造非法日期后,校验报错并阻断排程;修复后恢复', async () => {
    const store = await mountFresh();
    const bad = { ...store.state.data.events[0]!, earliestDay: 999 };
    store.updateEvent(bad);

    const codes = store.state.issues.map((i) => i.code);
    expect(codes).toContain('EVENT_DAY_RANGE');
    expect(store.state.issues.some((i) => i.severity === 'error')).toBe(true);
    expect(store.runScheduler()).not.toBeNull();

    const fixed = { ...bad, earliestDay: 0 };
    store.updateEvent(fixed);
    expect(store.state.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(store.runScheduler()).toBeNull();
  });

  it('作息与行程面板:锁定作息挡住玩家行程,拒绝结果可见', async () => {
    const store = await mountFresh();
    const charId = store.state.data.config.characterIds[0]!;
    const locId = store.state.data.config.locationIds[0]!;
    store.updateRoutine({
      id: 'rt_lock_smoke',
      characterId: charId,
      day: 0,
      slot: 0,
      locationId: locId,
      movable: false,
      movePolicy: MovePolicy.Nearest,
      dropPolicy: DropPolicy.Drop,
    });
    store.setActivities([{ clientId: 'act_smoke', day: 0, slot: 0, locationId: locId, characterIds: [charId] }]);
    store.runScheduler();

    (document.querySelector('[data-tab="routines"]') as HTMLButtonElement).click();
    expect(document.querySelector('.reject-box')?.textContent).toContain('act_smoke');
    expect(store.state.result!.rejectedActivities.map((r) => r.clientId)).toContain('act_smoke');
  });

  it('状态持久化到 localStorage,loadState 能原样读回', async () => {
    const store = await mountFresh();
    const ev = store.state.data.events[0]!;
    store.updateEvent({ ...ev, title: '持久化标题测试', postpone: PostponePolicy.NextAvailable });

    const { loadState } = await import('../src/editor/storage.js');
    const restored = loadState();
    expect(restored).not.toBeNull();
    expect(restored!.data.events[0]!.title).toBe('持久化标题测试');
    expect(restored!.data.events[0]!.postpone).toBe(PostponePolicy.NextAvailable);
  });
});
