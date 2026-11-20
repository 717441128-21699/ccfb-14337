import { collectReferencedEventIds } from './condition.js';
import {
  DropPolicy,
  MovePolicy,
  PostponePolicy,
  TOTAL_DAYS,
  type GameData,
  type PlayerActivity,
  type RoutineEntry,
  type ScheduleConfig,
} from './types.js';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  /** 关联实体 id,编辑页用于定位行 */
  entityId?: string;
  field?: string;
}

/**
 * 静态校验事件表与作息表。
 * error 必须修复后才能排程;warning/info 不阻断,但会在编辑页提示。
 */
export function validateGameData(data: GameData): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { config, events, routines } = data;

  validateConfig(config, issues);

  const locSet = new Set(config.locationIds);
  const charSet = new Set(config.characterIds);

  // ---- 事件表 --------------------------------------------------------------
  const eventIds = new Set<string>();
  for (const ev of events) {
    if (!ev.id) issues.push(err('EVENT_ID_EMPTY', '事件 id 不能为空', ev.id));
    if (eventIds.has(ev.id)) issues.push(err('EVENT_ID_DUP', `事件 id 重复: ${ev.id}`, ev.id));
    eventIds.add(ev.id);

    if (!Number.isInteger(ev.earliestDay) || ev.earliestDay < 0 || ev.earliestDay >= config.totalDays)
      issues.push(err('EVENT_DAY_RANGE', `earliestDay 超出 [0, ${config.totalDays - 1}]`, ev.id, 'earliestDay'));
    if (!Number.isInteger(ev.deadlineDay) || ev.deadlineDay < 0 || ev.deadlineDay >= config.totalDays)
      issues.push(err('EVENT_DAY_RANGE', `deadlineDay 超出 [0, ${config.totalDays - 1}]`, ev.id, 'deadlineDay'));
    if (ev.earliestDay > ev.deadlineDay)
      issues.push(err('EVENT_WINDOW_REVERSED', 'earliestDay 不能晚于 deadlineDay', ev.id));

    if (ev.slot !== null && (ev.slot < 0 || ev.slot >= config.slotsPerDay))
      issues.push(err('EVENT_SLOT_RANGE', `slot 超出 [0, ${config.slotsPerDay - 1}]`, ev.id, 'slot'));
    if (!locSet.has(ev.locationId))
      issues.push(err('EVENT_LOC_UNKNOWN', `引用了不存在的地点: ${ev.locationId}`, ev.id, 'locationId'));
    for (const cid of ev.characterIds) {
      if (!charSet.has(cid))
        issues.push(err('EVENT_CHAR_UNKNOWN', `引用了不存在的角色: ${cid}`, ev.id));
    if (ev.characterIds.length !== new Set(ev.characterIds).size)
      issues.push(err('EVENT_CHAR_DUP', 'characterIds 内存在重复角色', ev.id));
    }

    if (ev.postpone === PostponePolicy.NextAvailable) {
      const limit = ev.latestDelayDay ?? ev.deadlineDay;
      if (limit < ev.deadlineDay)
        issues.push(err('EVENT_DELAY_LIMIT', 'latestDelayDay 不能早于 deadlineDay', ev.id, 'latestDelayDay'));
      if (limit >= config.totalDays)
        issues.push(err('EVENT_DAY_RANGE', 'latestDelayDay 超出全年范围', ev.id, 'latestDelayDay'));
    }
    if (ev.maxPostponeCount !== undefined && ev.maxPostponeCount < 0)
      issues.push(err('EVENT_POSTPONE_NEG', 'maxPostponeCount 不能为负', ev.id));
    if (ev.tieBreakWeight < 0)
      issues.push(err('EVENT_WEIGHT_NEG', 'tieBreakWeight 不能为负', ev.id));
  }

  // 条件内引用:悬空事件 / 不存在的角色
  for (const ev of events) {
    const refs = new Set<string>();
    collectReferencedEventIds(ev.condition, refs);
    for (const ref of refs) {
      if (!eventIds.has(ref))
        issues.push(err('COND_EVENT_DANGLING', `条件引用了不存在的事件: ${ref}`, ev.id));
      if (ref === ev.id)
        issues.push(err('COND_EVENT_SELF', '事件条件引用了自身,会造成自锁', ev.id));
    }
    collectUnknownAffectionChars(ev.condition, charSet, issues, ev.id);
  }

  // 事件依赖环检测(eventState 边)
  detectDependencyCycle(events, issues);

  // 同地点同时段的窗口重叠 → 竞争预警(策划需确认优先级配置)
  detectPotentialContention(events, issues);

  // ---- 作息表 --------------------------------------------------------------
  const entryIds = new Set<string>();
  const charSlotSeen = new Map<string, string>();   // char|day|slot -> entryId
  const locSlotSeen = new Map<string, string>();    // loc|day|slot -> entryId
  for (const rt of routines) {
    if (!rt.id) issues.push(err('ROUTINE_ID_EMPTY', '作息条目 id 不能为空', rt.id));
    if (entryIds.has(rt.id)) issues.push(err('ROUTINE_ID_DUP', `作息条目 id 重复: ${rt.id}`, rt.id));
    entryIds.add(rt.id);

    if (!charSet.has(rt.characterId))
      issues.push(err('ROUTINE_CHAR_UNKNOWN', `引用了不存在的角色: ${rt.characterId}`, rt.id));
    if (!locSet.has(rt.locationId))
      issues.push(err('ROUTINE_LOC_UNKNOWN', `引用了不存在的地点: ${rt.locationId}`, rt.id));
    if (rt.day < 0 || rt.day >= config.totalDays)
      issues.push(err('ROUTINE_DAY_RANGE', 'day 超出全年范围', rt.id));
    if (rt.slot < 0 || rt.slot >= config.slotsPerDay)
      issues.push(err('ROUTINE_SLOT_RANGE', 'slot 超出时段范围', rt.id));
    if (!Object.values(MovePolicy).includes(rt.movePolicy))
      issues.push(err('ROUTINE_MOVE_POLICY', `未知迁移策略: ${rt.movePolicy}`, rt.id));
    if (!Object.values(DropPolicy).includes(rt.dropPolicy))
      issues.push(err('ROUTINE_DROP_POLICY', `未知丢弃规则: ${rt.dropPolicy}`, rt.id));
    if (rt.sourceEventId && !eventIds.has(rt.sourceEventId))
      issues.push(err('ROUTINE_EVENT_DANGLING', `sourceEventId 指向不存在的事件: ${rt.sourceEventId}`, rt.id));

    const ckey = `${rt.characterId}|${rt.day}|${rt.slot}`;
    const prevC = charSlotSeen.get(ckey);
    if (prevC)
      issues.push(warn('ROUTINE_CHAR_OVERLAP', `角色同时段作息冲突: 与 ${prevC} 重叠`, rt.id));
    else charSlotSeen.set(ckey, rt.id);

    const lkey = `${rt.locationId}|${rt.day}|${rt.slot}`;
    const prevL = locSlotSeen.get(lkey);
    if (prevL)
      issues.push(warn('ROUTINE_LOC_OVERLAP', `地点同时段作息冲突: 与 ${prevL} 重叠`, rt.id));
    else locSlotSeen.set(lkey, rt.id);
  }

  return issues;

  function err(code: string, message: string, entityId?: string, field?: string): ValidationIssue {
    return { severity: 'error', code, message, entityId, field };
  }
  function warn(code: string, message: string, entityId?: string): ValidationIssue {
    return { severity: 'warning', code, message, entityId };
  }
}

export function validateActivities(
  activities: readonly PlayerActivity[],
  config: ScheduleConfig,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const locSet = new Set(config.locationIds);
  const charSet = new Set(config.characterIds);
  const clientIds = new Set<string>();
  const seen = new Map<string, string>();

  for (const act of activities) {
    if (clientIds.has(act.clientId))
      issues.push({ severity: 'error', code: 'ACT_ID_DUP', message: `行程 clientId 重复: ${act.clientId}`, entityId: act.clientId });
    clientIds.add(act.clientId);

    if (act.day < 0 || act.day >= config.totalDays)
      issues.push({ severity: 'error', code: 'ACT_DAY_RANGE', message: '行程日期超出全年范围', entityId: act.clientId });
    if (act.slot < 0 || act.slot >= config.slotsPerDay)
      issues.push({ severity: 'error', code: 'ACT_SLOT_RANGE', message: '行程时段超出范围', entityId: act.clientId });
    if (!locSet.has(act.locationId))
      issues.push({ severity: 'error', code: 'ACT_LOC_UNKNOWN', message: `未知地点: ${act.locationId}`, entityId: act.clientId });
    for (const cid of act.characterIds) {
      if (!charSet.has(cid))
        issues.push({ severity: 'error', code: 'ACT_CHAR_UNKNOWN', message: `未知角色: ${cid}`, entityId: act.clientId });
    }
    const key = `${act.day}|${act.slot}|${act.locationId}`;
    const prev = seen.get(key);
    if (prev)
      issues.push({ severity: 'warning', code: 'ACT_LOC_OVERLAP', message: `与行程 ${prev} 在同地点同时段冲突`, entityId: act.clientId });
    else seen.set(key, act.clientId);
  }
  return issues;
}

function validateConfig(config: ScheduleConfig, issues: ValidationIssue[]): void {
  if (config.totalDays !== TOTAL_DAYS)
    issues.push({ severity: 'warning', code: 'CFG_DAYS', message: `当前产品约定全年 ${TOTAL_DAYS} 天,配置为 ${config.totalDays}` });
  if (config.slotsPerDay <= 0)
    issues.push({ severity: 'error', code: 'CFG_SLOTS', message: 'slotsPerDay 必须大于 0' });
  if (new Set(config.locationIds).size !== config.locationIds.length)
    issues.push({ severity: 'error', code: 'CFG_LOC_DUP', message: 'locationIds 存在重复' });
  if (new Set(config.characterIds).size !== config.characterIds.length)
    issues.push({ severity: 'error', code: 'CFG_CHAR_DUP', message: 'characterIds 存在重复' });
}

function collectUnknownAffectionChars(
  expr: import('./types.js').ConditionExpr,
  charSet: Set<string>,
  issues: ValidationIssue[],
  eventId: string,
): void {
  switch (expr.kind) {
    case 'all':
    case 'any':
      expr.of.forEach((s) => collectUnknownAffectionChars(s, charSet, issues, eventId));
      return;
    case 'not':
      collectUnknownAffectionChars(expr.expr, charSet, issues, eventId);
      return;
    case 'affection':
      if (!charSet.has(expr.character))
        issues.push({ severity: 'error', code: 'COND_CHAR_DANGLING', message: `条件引用了不存在的角色: ${expr.character}`, entityId: eventId });
      return;
    default:
      return;
  }
}

function detectDependencyCycle(
  events: import('./types.js').EventDef[],
  issues: ValidationIssue[],
): void {
  const edges = new Map<string, string[]>();
  for (const ev of events) {
    const refs = new Set<string>();
    collectReferencedEventIds(ev.condition, refs);
    edges.set(ev.id, [...refs]);
  }
  const state = new Map<string, 0 | 1 | 2>(); // 0=未访问 1=栈中 2=完成
  const stack: string[] = [];

  const visit = (id: string): boolean => {
    const mark = state.get(id) ?? 0;
    if (mark === 1) {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(' → ');
      issues.push({ severity: 'error', code: 'COND_CYCLE', message: `事件依赖存在环: ${cycle}`, entityId: id });
      return true;
    }
    if (mark === 2) return false;
    state.set(id, 1);
    stack.push(id);
    let found = false;
    for (const next of edges.get(id) ?? []) {
      if (edges.has(next) && visit(next)) { found = true; break; }
    }
    stack.pop();
    state.set(id, 2);
    return found;
  };

  for (const ev of events) {
    if ((state.get(ev.id) ?? 0) === 0) visit(ev.id);
  }
}

/**
 * 同地点 + 同时段(含 null 全天)且触发窗口重叠的事件对,
 * 排程时必然互相竞争,提示策划确认 priority / postpone 配置。
 */
function detectPotentialContention(
  events: import('./types.js').EventDef[],
  issues: ValidationIssue[],
): void {
  type BucketKey = string;
  const buckets = new Map<BucketKey, import('./types.js').EventDef[]>();
  for (const ev of events) {
    // slot=null 与每个具体 slot 都可能竞争,统一归入 '*' 桶再做过滤
    const key = `${ev.locationId}|${ev.slot ?? '*'}`;
    const list = buckets.get(key);
    if (list) list.push(ev);
    else buckets.set(key, [ev]);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const slotCompatible = a.slot === null || b.slot === null || a.slot === b.slot;
        const windowOverlap = a.earliestDay <= b.deadlineDay && b.earliestDay <= a.deadlineDay;
        if (slotCompatible && windowOverlap) {
          issues.push({
            severity: 'info',
            code: 'EVENT_CONTENTION',
            message: `事件 ${a.id} 与 ${b.id} 在同地点同时段窗口重叠,将按优先级仲裁`,
            entityId: a.id,
          });
        }
      }
    }
  }
}
