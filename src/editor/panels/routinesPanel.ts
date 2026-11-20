import { DropPolicy, MovePolicy, type PlayerActivity, type RoutineEntry } from '../../core/index.js';
import type { EditorState } from '../state.js';

type Toast = (msg: string, kind?: 'info' | 'error' | 'ok') => void;

interface PanelStore {
  state: EditorState;
  updateRoutine: (rt: RoutineEntry) => void;
  deleteRoutine: (id: string) => void;
  setActivities: (a: PlayerActivity[]) => void;
}

export function renderRoutinesPanel(slot: HTMLElement, store: PanelStore, toast: Toast): void {
  const { data, activities } = store.state;

  slot.innerHTML = `
    <div class="routines-layout">
      <section>
        <div class="pane-head">
          <h2>角色作息(${data.routines.length})</h2>
          <button id="btn-add-routine" class="small">+ 新建作息</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>id</th><th>角色</th><th>日</th><th>时段</th><th>地点</th><th>可移动</th><th>迁移</th><th>丢弃</th><th></th></tr></thead>
            <tbody>
              ${data.routines.map((rt) => `
                <tr>
                  <td><code>${rt.id}</code></td>
                  <td>${rt.characterId}</td>
                  <td>${rt.day}</td>
                  <td>${rt.slot}</td>
                  <td>${rt.locationId}</td>
                  <td>${rt.movable ? '✓' : '✗'}</td>
                  <td>${rt.movePolicy}</td>
                  <td>${rt.dropPolicy}</td>
                  <td><button class="link danger" data-del-rt="${rt.id}">删除</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div id="routine-form-slot"></div>
      </section>

      <section>
        <div class="pane-head">
          <h2>玩家行程(${activities.length})</h2>
          <button id="btn-add-activity" class="small">+ 预约角色</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>clientId</th><th>日</th><th>时段</th><th>地点</th><th>预约角色</th><th></th></tr></thead>
            <tbody>
              ${activities.map((a) => `
                <tr>
                  <td><code>${a.clientId}</code></td>
                  <td>${a.day}</td>
                  <td>${a.slot}</td>
                  <td>${a.locationId}</td>
                  <td>${a.characterIds.join(', ') || '—'}</td>
                  <td><button class="link danger" data-del-act="${a.clientId}">删除</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div id="activity-form-slot"></div>
        ${store.state.result ? renderRejections(store.state.result.rejectedActivities) : ''}
      </section>
    </div>
  `;

  slot.querySelectorAll<HTMLButtonElement>('[data-del-rt]').forEach((btn) =>
    btn.addEventListener('click', () => {
      store.deleteRoutine(btn.dataset.delRt!);
      toast('作息已删除', 'ok');
    }),
  );
  slot.querySelectorAll<HTMLButtonElement>('[data-del-act]').forEach((btn) =>
    btn.addEventListener('click', () => {
      store.setActivities(activities.filter((a) => a.clientId !== btn.dataset.delAct));
    }),
  );

  slot.querySelector('#btn-add-routine')!.addEventListener('click', () =>
    renderRoutineForm(slot.querySelector('#routine-form-slot')!, store, toast, null),
  );
  slot.querySelector('#btn-add-activity')!.addEventListener('click', () =>
    renderActivityForm(slot.querySelector('#activity-form-slot')!, store, toast),
  );
}

function renderRejections(rejected: { clientId: string; reason: string }[]): string {
  if (rejected.length === 0) return '<p class="hint">上次排程没有被拒绝的行程。</p>';
  return `<div class="reject-box"><h3>被拒绝的行程(${rejected.length})</h3><ul>${rejected
    .map((r) => `<li><code>${r.clientId}</code>:${escapeHtml(r.reason)}</li>`)
    .join('')}</ul></div>`;
}

function renderRoutineForm(formSlot: HTMLElement, store: PanelStore, toast: Toast, existing: RoutineEntry | null): void {
  const { config } = store.state.data;
  const rt: RoutineEntry = existing ?? {
    id: `rt_new_${Date.now()}`,
    characterId: config.characterIds[0]!,
    day: 0,
    slot: 0,
    locationId: config.locationIds[0]!,
    movable: true,
    movePolicy: MovePolicy.Nearest,
    maxBackwardDays: 7,
    maxForwardDays: 7,
    dropPolicy: DropPolicy.Drop,
  };

  formSlot.innerHTML = `
    <h3>${existing ? '编辑作息' : '新建作息'}</h3>
    <div class="form-grid">
      <label>id<input id="rt-id" value="${rt.id}" ${existing ? 'disabled' : ''} /></label>
      <label>角色<select id="rt-char">${config.characterIds.map((c) => `<option ${c === rt.characterId ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label>日<input type="number" min="0" max="359" id="rt-day" value="${rt.day}" /></label>
      <label>时段<input type="number" min="0" max="${config.slotsPerDay - 1}" id="rt-slot" value="${rt.slot}" /></label>
      <label>地点<select id="rt-loc">${config.locationIds.map((l) => `<option ${l === rt.locationId ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>可移动<select id="rt-movable"><option value="true" ${rt.movable ? 'selected' : ''}>是</option><option value="false" ${!rt.movable ? 'selected' : ''}>否(剧情锁定)</option></select></label>
      <label>迁移策略<select id="rt-move">${Object.values(MovePolicy).map((m) => `<option ${m === rt.movePolicy ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label>向前上限<input type="number" id="rt-back" value="${rt.maxBackwardDays ?? 7}" /></label>
      <label>向后上限<input type="number" id="rt-fwd" value="${rt.maxForwardDays ?? 7}" /></label>
      <label>丢弃规则<select id="rt-drop">${Object.values(DropPolicy).map((d) => `<option ${d === rt.dropPolicy ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
    </div>
    <div class="form-actions"><button id="rt-save" class="primary small">保存作息</button></div>
  `;

  formSlot.querySelector('#rt-save')!.addEventListener('click', () => {
    const val = (id: string): string => (formSlot.querySelector(id) as HTMLInputElement | HTMLSelectElement).value;
    const next: RoutineEntry = {
      ...rt,
      id: val('#rt-id'),
      characterId: val('#rt-char'),
      day: Number(val('#rt-day')),
      slot: Number(val('#rt-slot')),
      locationId: val('#rt-loc'),
      movable: val('#rt-movable') === 'true',
      movePolicy: val('#rt-move') as MovePolicy,
      maxBackwardDays: Number(val('#rt-back')),
      maxForwardDays: Number(val('#rt-fwd')),
      dropPolicy: val('#rt-drop') as DropPolicy,
    };
    store.updateRoutine(next);
    toast('作息已保存', 'ok');
    formSlot.innerHTML = '';
  });
}

function renderActivityForm(formSlot: HTMLElement, store: PanelStore, toast: Toast): void {
  const { config } = store.state.data;
  formSlot.innerHTML = `
    <h3>新建玩家行程</h3>
    <div class="form-grid">
      <label>日<input type="number" min="0" max="359" id="act-day" value="0" /></label>
      <label>时段<input type="number" min="0" max="${config.slotsPerDay - 1}" id="act-slot" value="0" /></label>
      <label>地点<select id="act-loc">${config.locationIds.map((l) => `<option>${l}</option>`).join('')}</select></label>
      <label>预约角色(可空)<select id="act-char"><option value="">(单人行程)</option>${config.characterIds.map((c) => `<option>${c}</option>`).join('')}</select></label>
    </div>
    <div class="form-actions"><button id="act-save" class="primary small">添加行程</button></div>
  `;
  formSlot.querySelector('#act-save')!.addEventListener('click', () => {
    const val = (id: string): string => (formSlot.querySelector(id) as HTMLInputElement | HTMLSelectElement).value;
    const charVal = val('#act-char');
    const activity: PlayerActivity = {
      clientId: `act_${Date.now()}`,
      day: Number(val('#act-day')),
      slot: Number(val('#act-slot')),
      locationId: val('#act-loc'),
      characterIds: charVal ? [charVal] : [],
    };
    store.setActivities([...store.state.activities, activity]);
    toast('行程已添加,点击顶部「重新排程」查看冲突处理', 'ok');
    formSlot.innerHTML = '';
  });
}

function escapeHtml(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
