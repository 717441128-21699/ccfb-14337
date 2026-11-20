import { generateGameData } from '../core/index.js';
import type { EditorState } from './state.js';

interface GenStore {
  state: EditorState;
  replaceAll: (data: EditorState['data'], activities: EditorState['activities']) => void;
}

type Toast = (msg: string, kind?: 'info' | 'error' | 'ok') => void;

/** 顶部工具栏的「生成测试数据」弹层 */
export function mountGenerator(button: HTMLButtonElement, store: GenStore, toast: Toast): void {
  button.addEventListener('click', () => {
    const seed = window.prompt('随机种子(整数,同种子生成同一张表)', '20261121');
    if (seed === null) return;
    const countRaw = window.prompt('事件条数', '1000');
    if (countRaw === null) return;
    const eventCount = Number(countRaw);
    if (!Number.isFinite(eventCount) || eventCount <= 0) {
      toast('事件条数必须是正整数', 'error');
      return;
    }
    const data = generateGameData({ seed: Number(seed) || 1, eventCount });
    store.replaceAll(data, []);
    toast(`已生成 ${eventCount} 条事件、${data.routines.length} 条作息的 360 天测试表`, 'ok');
  });
}
