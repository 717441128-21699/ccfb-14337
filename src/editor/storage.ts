import type { GameData, PlayerActivity, ScheduleResult } from '../core/types.js';

const STORAGE_KEY = 'life-sim-editor-state-v1';

interface PersistedState {
  data: GameData;
  activities: PlayerActivity[];
}

export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed.data || !Array.isArray(parsed.data.events)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveState(data: GameData, activities: PlayerActivity[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ data, activities }));
  } catch (err) {
    console.warn('本地持久化失败(可能超出容量限制)', err);
  }
}

export function exportJson(data: GameData, activities: PlayerActivity[], result: ScheduleResult | null): string {
  return JSON.stringify({ data, activities, lastResult: result, exportedAt: new Date().toISOString() }, null, 2);
}

export function downloadJson(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
