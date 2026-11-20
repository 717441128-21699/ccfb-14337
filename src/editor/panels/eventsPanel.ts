import { PostponePolicy, type ConditionExpr, type EventDef } from '../../core/index.js';
import type { EditorState } from '../state.js';

interface EditorStore {
  state: EditorState;
  updateEvent: (e: EventDef) => void;
  deleteEvent: (id: string) => void;
  addEvent: (e: EventDef) => void;
}
type Toast = (msg: string, kind?: 'info' | 'error' | 'ok') => void;

export function renderEventsPanel(slot: HTMLElement, store: EditorStore, toast: Toast): void {
  const { data, selectedEventId } = store.state;
  const selected = data.events.find((e) => e.id === selectedEventId) ?? null;

  slot.innerHTML = `
    <div class="events-layout">
      <div class="event-list-pane">
        <div class="pane-head">
          <h2>事件表(${data.events.length})</h2>
          <button id="btn-add-event" class="small">+ 新建事件</button>
        </div>
        <input id="event-filter" class="filter" placeholder="按 id / 标题 / 地点过滤…" />
        <div class="event-table-wrap">
          <table class="event-table">
            <thead><tr><th>id</th><th>标题</th><th>窗口</th><th>时段</th><th>地点</th><th>优先级</th><th>顺延</th></tr></thead>
            <tbody id="event-rows"></tbody>
          </table>
        </div>
      </div>
      <div class="event-form-pane" id="event-form-slot"></div>
    </div>
  `;

  const rowsSlot = slot.querySelector<HTMLTableSectionElement>('#event-rows')!;
  const filterInput = slot.querySelector<HTMLInputElement>('#event-filter')!;

  const drawRows = (filter = ''): void => {
    const q = filter.trim().toLowerCase();
    const list = data.events.filter((e) =>
      !q || e.id.toLowerCase().includes(q) || e.title.toLowerCase().includes(q) || e.locationId.toLowerCase().includes(q),
    );
    rowsSlot.innerHTML = list.map((e) => `
      <tr data-id="${e.id}" class="${e.id === selectedEventId ? 'selected' : ''}">
        <td><code>${e.id}</code></td>
        <td>${escapeHtml(e.title)}</td>
        <td>${e.earliestDay}–${e.deadlineDay}</td>
        <td>${e.slot === null ? '全天' : e.slot}</td>
        <td>${e.locationId}</td>
        <td>${e.priority}</td>
        <td>${e.postpone}</td>
      </tr>
    `).join('');
    rowsSlot.querySelectorAll('tr').forEach((tr) => {
      tr.addEventListener('click', () => {
        store.state.selectedEventId = tr.dataset.id!;
        renderEventsPanel(slot, store, toast);
      });
    });
  };
  drawRows();
  filterInput.addEventListener('input', () => drawRows(filterInput.value));

  slot.querySelector('#btn-add-event')!.addEventListener('click', () => {
    const seq = data.events.length + 1;
    const template: EventDef = {
      id: `evt_new_${Date.now()}`,
      title: `新事件 ${seq}`,
      earliestDay: 0,
      deadlineDay: 10,
      slot: 0,
      locationId: data.config.locationIds[0]!,
      characterIds: [],
      condition: { kind: 'const', value: true },
      priority: 0,
      tieBreakWeight: 0,
      postpone: PostponePolicy.WithinWindow,
      maxPostponeCount: 12,
    };
    store.addEvent(template);
  });

  const formSlot = slot.querySelector<HTMLDivElement>('#event-form-slot')!;
  if (selected) renderForm(formSlot, selected, data, store, toast);
  else formSlot.innerHTML = '<p class="hint">从左侧选择一个事件进行编辑,或点击「新建事件」。</p>';
}

function renderForm(
  formSlot: HTMLElement,
  ev: EventDef,
  data: EditorState['data'],
  store: Pick<EditorStore, 'updateEvent' | 'deleteEvent' | 'state'>,
  toast: Toast,
): void {
  const locOptions = data.config.locationIds.map((id) => `<option value="${id}" ${id === ev.locationId ? 'selected' : ''}>${id}</option>`).join('');
  const charCheckboxes = data.config.characterIds.map((id) => `
    <label class="check"><input type="checkbox" data-field="char" value="${id}" ${ev.characterIds.includes(id) ? 'checked' : ''}/> ${id}</label>
  `).join('');

  formSlot.innerHTML = `
    <h2>事件编辑</h2>
    <div class="form-grid">
      <label>id<input data-field="id" value="${escapeAttr(ev.id)}" /></label>
      <label>标题<input data-field="title" value="${escapeAttr(ev.title)}" /></label>
      <label>最早日<input type="number" min="0" max="359" data-field="earliestDay" value="${ev.earliestDay}" /></label>
      <label>截止日<input type="number" min="0" max="359" data-field="deadlineDay" value="${ev.deadlineDay}" /></label>
      <label>时段(留空=全天)<input type="number" min="0" max="${data.config.slotsPerDay - 1}" data-field="slot" value="${ev.slot ?? ''}" placeholder="全天" /></label>
      <label>地点<select data-field="locationId">${locOptions}</select></label>
      <label>优先级<input type="number" data-field="priority" value="${ev.priority}" /></label>
      <label>决胜权重<input type="number" min="0" data-field="tieBreakWeight" value="${ev.tieBreakWeight}" /></label>
      <label>顺延策略
        <select data-field="postpone">
          ${Object.values(PostponePolicy).map((p) => `<option value="${p}" ${p === ev.postpone ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </label>
      <label>顺延下限<input type="number" min="0" max="359" data-field="latestDelayDay" value="${ev.latestDelayDay ?? ''}" placeholder="默认=截止日" /></label>
      <label>最大顺延次数<input type="number" min="0" data-field="maxPostponeCount" value="${ev.maxPostponeCount ?? 12}" /></label>
      <label>互斥组<input data-field="exclusiveKey" value="${ev.exclusiveKey ?? ''}" placeholder="可选" /></label>
    </div>
    <fieldset>
      <legend>在场角色</legend>
      <div class="checkbox-row">${charCheckboxes}</div>
    </fieldset>
    <fieldset>
      <legend>触发条件(结构化 JSON,语法见条件表达式文档)</legend>
      <textarea id="condition-json" rows="8" class="mono">${escapeHtml(JSON.stringify(ev.condition, null, 2))}</textarea>
      <p id="condition-error" class="field-error" hidden></p>
    </fieldset>
    <label class="full">备注<input data-field="note" value="${escapeAttr(ev.note ?? '')}" /></label>
    <div class="form-actions">
      <button id="btn-save" class="primary">保存</button>
      <button id="btn-delete" class="danger">删除事件</button>
    </div>
  `;

  const readForm = (): EventDef | { error: string } => {
    const get = (field: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
      formSlot.querySelector(`[data-field="${field}"]`)!;
    const slotRaw = (get('slot') as HTMLInputElement).value.trim();
    let condition: ConditionExpr;
    try {
      condition = JSON.parse(formSlot.querySelector<HTMLTextAreaElement>('#condition-json')!.value) as ConditionExpr;
    } catch (err) {
      return { error: `条件 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}` };
    }
    const chars = [...formSlot.querySelectorAll<HTMLInputElement>('[data-field="char"]:checked')].map((c) => c.value);
    return {
      ...ev,
      id: (get('id') as HTMLInputElement).value.trim(),
      title: (get('title') as HTMLInputElement).value,
      earliestDay: Number(get('earliestDay').value),
      deadlineDay: Number(get('deadlineDay').value),
      slot: slotRaw === '' ? null : Number(slotRaw),
      locationId: get('locationId').value,
      characterIds: chars,
      priority: Number(get('priority').value),
      tieBreakWeight: Number(get('tieBreakWeight').value),
      postpone: get('postpone').value as PostponePolicy,
      latestDelayDay: (get('latestDelayDay') as HTMLInputElement).value === '' ? undefined : Number(get('latestDelayDay').value),
      maxPostponeCount: Number(get('maxPostponeCount').value),
      exclusiveKey: (get('exclusiveKey') as HTMLInputElement).value || undefined,
      note: (get('note') as HTMLInputElement).value || undefined,
      condition,
    };
  };

  formSlot.querySelector('#btn-save')!.addEventListener('click', () => {
    const next = readForm();
    const errEl = formSlot.querySelector<HTMLParagraphElement>('#condition-error')!;
    if ('error' in next) {
      errEl.textContent = next.error;
      errEl.hidden = false;
      toast(next.error, 'error');
      return;
    }
    errEl.hidden = true;
    if (next.id !== ev.id) store.state.selectedEventId = next.id;
    store.updateEvent(next);
    toast('事件已保存', 'ok');
  });

  formSlot.querySelector('#btn-delete')!.addEventListener('click', () => {
    if (window.confirm(`确认删除事件 ${ev.id}?`)) {
      store.deleteEvent(ev.id);
      toast('事件已删除', 'ok');
    }
  });
}

function escapeHtml(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function escapeAttr(input: string): string {
  return escapeHtml(input).replaceAll('"', '&quot;');
}
