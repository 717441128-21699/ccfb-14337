import type { GameData, PlayerActivity } from '../core/types.js';
import { downloadJson, exportJson } from './storage.js';
import { mountGenerator } from './generator.js';
import { renderEventsPanel } from './panels/eventsPanel.js';
import { renderRoutinesPanel } from './panels/routinesPanel.js';
import { renderSchedulePanel } from './panels/schedulePanel.js';
import { renderValidationPanel } from './panels/validationPanel.js';
import { EditorStore, createInitialState, POSTPONE_LABELS, type EditorState } from './state.js';

export type { EditorState } from './state.js';
export { POSTPONE_LABELS } from './state.js';
export type EditorStoreType = EditorStore;
type Toast = (msg: string, kind?: 'info' | 'error' | 'ok') => void;

/**
 * 在 #app 上挂载编辑台。每次调用都基于全新 store,便于测试隔离;
 * 生产入口 main.ts 只调用一次。
 */
export function initEditor(root: HTMLElement): EditorStore {
  const store = new EditorStore(createInitialState());

  root.innerHTML = `
    <header class="topbar">
      <h1>养成游戏 · 日程与事件调度台</h1>
      <div class="topbar-actions">
        <button id="btn-run" class="primary">▶ 重新排程</button>
        <button id="btn-generate">生成 360 天测试表</button>
        <button id="btn-export">导出 JSON</button>
        <button id="btn-import">导入 JSON</button>
        <input type="file" id="file-import" accept="application/json" hidden />
      </div>
    </header>
    <section id="validation-slot"></section>
    <main class="layout">
      <nav class="tabs" role="tablist">
        <button class="tab active" data-tab="events">事件表</button>
        <button class="tab" data-tab="routines">作息与行程</button>
        <button class="tab" data-tab="schedule">全年队列</button>
      </nav>
      <section id="panel-slot" class="panel"></section>
    </main>
    <div id="toast" class="toast" hidden></div>
  `;

  const toast: Toast = (msg, kind = 'info'): void => {
    const el = root.querySelector<HTMLDivElement>('#toast')!;
    el.textContent = msg;
    el.className = `toast ${kind}`;
    el.hidden = false;
    window.setTimeout(() => { el.hidden = true; }, 3200);
  };

  let activeTab = 'events';
  const panelSlot = root.querySelector<HTMLDivElement>('#panel-slot')!;
  const validationSlot = root.querySelector<HTMLDivElement>('#validation-slot')!;

  const renderActivePanel = (): void => {
    if (activeTab === 'events') renderEventsPanel(panelSlot, store, toast);
    else if (activeTab === 'routines') renderRoutinesPanel(panelSlot, store, toast);
    else renderSchedulePanel(panelSlot, store);
  };

  const renderAll = (): void => {
    renderValidationPanel(validationSlot, store.state.issues);
    renderActivePanel();
    const errorCount = store.state.issues.filter((i) => i.severity === 'error').length;
    root.querySelector<HTMLButtonElement>('#btn-run')!.disabled = errorCount > 0;
  };

  store.subscribe(renderAll);

  root.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab!;
      root.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      renderActivePanel();
    });
  });

  root.querySelector<HTMLButtonElement>('#btn-run')!.addEventListener('click', () => {
    const err = store.runScheduler();
    if (err) {
      toast(err, 'error');
      return;
    }
    const r = store.state.result!;
    toast(`排程完成:${r.stats.scheduled} 个事件,${r.stats.postponedTotal} 次顺延,耗时 ${r.stats.elapsedMs?.toFixed(2)}ms`, 'ok');
    activeTab = 'schedule';
    root.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', (b as HTMLButtonElement).dataset.tab === 'schedule'));
    renderActivePanel();
  });

  root.querySelector<HTMLButtonElement>('#btn-export')!.addEventListener('click', () => {
    downloadJson('schedule-data.json', exportJson(store.state.data, store.state.activities, store.state.result));
    toast('已导出 JSON', 'ok');
  });

  mountGenerator(root.querySelector<HTMLButtonElement>('#btn-generate')!, store, toast);

  const fileInput = root.querySelector<HTMLInputElement>('#file-import')!;
  root.querySelector<HTMLButtonElement>('#btn-import')!.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (): void => {
      try {
        const parsed = JSON.parse(String(reader.result)) as { data: GameData; activities?: PlayerActivity[] };
        if (!parsed.data?.config || !Array.isArray(parsed.data.events)) throw new Error('文件结构不符合 { data, activities } 约定');
        store.replaceAll(parsed.data, parsed.activities ?? []);
        toast(`已导入 ${parsed.data.events.length} 条事件`, 'ok');
      } catch (err) {
        toast(`导入失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
      } finally {
        fileInput.value = '';
      }
    };
    reader.readAsText(file);
  });

  renderAll();
  return store;
}
