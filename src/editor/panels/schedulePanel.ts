import type { EventLifecycleState, ScheduleResult } from '../../core/index.js';
import type { EditorState } from '../state.js';

const STATE_LABEL: Record<EventLifecycleState, string> = {
  pending: '未进窗口',
  active: '等待中',
  scheduled: '已排期',
  triggered: '已触发',
  postponed: '顺延中',
  missed: '已错过',
  expired: '已过期',
};

const STATE_COLOR: Record<EventLifecycleState, string> = {
  pending: 'state-pending',
  active: 'state-active',
  scheduled: 'state-scheduled',
  triggered: 'state-triggered',
  postponed: 'state-postponed',
  missed: 'state-missed',
  expired: 'state-expired',
};

export function renderSchedulePanel(slot: HTMLElement, store: { state: EditorState }): void {
  const { result, data } = store.state;
  if (!result) {
    slot.innerHTML = '<p class="hint">还没有排程结果。修正校验问题后点击顶部「▶ 重新排程」。</p>';
    return;
  }

  const titleById = new Map(data.events.map((e) => [e.id, e.title]));
  const routineByEntry = new Map(data.routines.map((r) => [r.id, r]));

  slot.innerHTML = `
    <div class="schedule-head">
      <h2>全年事件队列</h2>
      <div class="stats-grid">
        ${statCard('事件总数', result.stats.totalEvents)}
        ${statCard('已排期', result.stats.scheduled, 'ok')}
        ${statCard('顺延总次数', result.stats.postponedTotal, 'warn')}
        ${statCard('错过', result.stats.missed, 'err')}
        ${statCard('过期', result.stats.expired, 'err')}
        ${statCard('作息迁移', result.stats.routinesMoved, 'warn')}
        ${statCard('作息丢弃', result.stats.routinesDropped, 'err')}
        ${statCard('耗时', `${result.stats.elapsedMs?.toFixed(2)}ms`, 'ok')}
      </div>
    </div>

    <div class="schedule-controls">
      <label>跳转到天 <input type="number" id="day-jump" min="0" max="359" value="0" /></label>
      <label>状态过滤
        <select id="state-filter">
          <option value="">全部</option>
          ${Object.keys(STATE_LABEL).map((s) => `<option value="${s}">${STATE_LABEL[s as EventLifecycleState]}</option>`).join('')}
        </select>
      </label>
      <input id="queue-filter" class="filter" placeholder="按事件 id / 标题过滤…" />
    </div>

    <div class="schedule-columns">
      <div>
        <h3>事件状态明细(${result.eventStatus.length})</h3>
        <div class="table-wrap status-wrap">
          <table>
            <thead><tr><th>事件</th><th>状态</th><th>排期日</th><th>顺延次数</th></tr></thead>
            <tbody id="status-rows"></tbody>
          </table>
        </div>
      </div>
      <div>
        <h3 id="day-title">第 0 天 · 当日视图</h3>
        <div id="day-view" class="day-view"></div>
        <h3>作息迁移/丢弃明细</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>条目</th><th>角色</th><th>原日</th><th>落位日</th><th>偏移</th><th>标记</th></tr></thead>
            <tbody>
              ${result.routinePlacements.filter((p) => p.movedByDays !== 0 || p.dropped || p.conflict).map((p) => `
                <tr>
                  <td><code>${p.entryId}</code></td>
                  <td>${p.characterId}</td>
                  <td>${p.originalDay}</td>
                  <td>${p.dropped ? '—' : p.day}</td>
                  <td>${p.movedByDays > 0 ? '+' : ''}${p.movedByDays}</td>
                  <td>${p.dropped ? '<span class="tag err">丢弃</span>' : ''}${p.conflict ? '<span class="tag warn">冲突保留</span>' : ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  const statusRows = slot.querySelector<HTMLTableSectionElement>('#status-rows')!;
  const drawStatus = (stateFilter: string, textFilter: string): void => {
    const q = textFilter.trim().toLowerCase();
    const rows = result.eventStatus.filter((r) => {
      if (stateFilter && r.state !== stateFilter) return false;
      if (!q) return true;
      return r.eventId.toLowerCase().includes(q) || (titleById.get(r.eventId) ?? '').toLowerCase().includes(q);
    });
    statusRows.innerHTML = rows.map((r) => `
      <tr class="${STATE_COLOR[r.state]}">
        <td><code>${r.eventId}</code><div class="sub">${escapeHtml(titleById.get(r.eventId) ?? '')}</div></td>
        <td><span class="tag ${STATE_COLOR[r.state]}">${STATE_LABEL[r.state]}</span></td>
        <td>${r.scheduledDay ?? '—'}</td>
        <td>${r.postponeCount}</td>
      </tr>
    `).join('');
  };
  drawStatus('', '');

  const stateFilter = slot.querySelector<HTMLSelectElement>('#state-filter')!;
  const queueFilter = slot.querySelector<HTMLInputElement>('#queue-filter')!;
  stateFilter.addEventListener('change', () => drawStatus(stateFilter.value, queueFilter.value));
  queueFilter.addEventListener('input', () => drawStatus(stateFilter.value, queueFilter.value));

  const dayView = slot.querySelector<HTMLDivElement>('#day-view')!;
  const dayTitle = slot.querySelector<HTMLHeadingElement>('#day-title')!;
  const drawDay = (day: number): void => {
    dayTitle.textContent = `第 ${day} 天 · 当日视图`;
    const eventsToday = result.scheduledEvents.filter((s) => s.day === day);
    const routinesToday = result.routinePlacements.filter((p) => !p.dropped && p.day === day);
    const slotCount = data.config.slotsPerDay;
    const rows: string[] = [];
    for (let s = 0; s < slotCount; s++) {
      const evs = eventsToday.filter((e) => e.slot === s);
      const rts = routinesToday.filter((r) => r.slot === s);
      rows.push(`
        <tr>
          <td class="slot-label">时段 ${s}</td>
          <td>
            ${evs.map((e) => `<div class="chip event">📖 ${escapeHtml(titleById.get(e.eventId) ?? e.eventId)} @${e.locationId}${e.postponeCount ? ` <em>(顺延${e.postponeCount})</em>` : ''}</div>`).join('') || '<span class="muted">无事件</span>'}
            ${rts.map((r) => `<div class="chip routine">🕒 ${r.characterId} @${r.locationId}${routineByEntry.get(r.entryId)?.movable ? '' : ' 🔒'}</div>`).join('')}
          </td>
        </tr>`);
    }
    dayView.innerHTML = `<table class="day-table">${rows.join('')}</table>`;
  };
  drawDay(0);

  const jump = slot.querySelector<HTMLInputElement>('#day-jump')!;
  jump.addEventListener('change', () => {
    const day = Math.max(0, Math.min(359, Number(jump.value) || 0));
    jump.value = String(day);
    drawDay(day);
  });
  // 点击状态行可跳到对应排期日
  statusRows.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr');
    if (!tr) return;
    const eventId = tr.querySelector('code')?.textContent;
    const row = result.eventStatus.find((r) => r.eventId === eventId);
    if (row?.scheduledDay != null) {
      jump.value = String(row.scheduledDay);
      drawDay(row.scheduledDay);
    }
  });
}

function statCard(label: string, value: string | number, cls = ''): string {
  return `<div class="stat-card ${cls}"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`;
}

function escapeHtml(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
