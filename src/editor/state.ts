import {
  DropPolicy,
  MovePolicy,
  PostponePolicy,
  Scheduler,
  validateActivities,
  validateGameData,
  type EventDef,
  type GameData,
  type PlayerActivity,
  type RoutineEntry,
  type ScheduleResult,
  type ValidationIssue,
} from '../core/index.js';
import { loadState, saveState } from './storage.js';

export interface EditorState {
  data: GameData;
  activities: PlayerActivity[];
  result: ScheduleResult | null;
  issues: ValidationIssue[];
  selectedEventId: string | null;
}

type Listener = (state: EditorState) => void;

export class EditorStore {
  state: EditorState;
  private readonly listeners = new Set<Listener>();

  constructor(initial: EditorState) {
    this.state = initial;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.state.issues = [
      ...validateGameData(this.state.data),
      ...validateActivities(this.state.activities, this.state.data.config),
    ];
    saveState(this.state.data, this.state.activities);
    for (const fn of this.listeners) fn(this.state);
  }

  updateEvent(ev: EventDef): void {
    const idx = this.state.data.events.findIndex((e) => e.id === ev.id);
    if (idx >= 0) this.state.data.events[idx] = ev;
    else this.state.data.events.push(ev);
    this.emit();
  }

  deleteEvent(id: string): void {
    this.state.data.events = this.state.data.events.filter((e) => e.id !== id);
    if (this.state.selectedEventId === id) this.state.selectedEventId = null;
    this.emit();
  }

  addEvent(template: EventDef): void {
    this.state.data.events.push(template);
    this.state.selectedEventId = template.id;
    this.emit();
  }

  updateRoutine(rt: RoutineEntry): void {
    const idx = this.state.data.routines.findIndex((r) => r.id === rt.id);
    if (idx >= 0) this.state.data.routines[idx] = rt;
    else this.state.data.routines.push(rt);
    this.emit();
  }

  deleteRoutine(id: string): void {
    this.state.data.routines = this.state.data.routines.filter((r) => r.id !== id);
    this.emit();
  }

  setActivities(activities: PlayerActivity[]): void {
    this.state.activities = activities;
    this.emit();
  }

  replaceAll(data: GameData, activities: PlayerActivity[]): void {
    this.state.data = data;
    this.state.activities = activities;
    this.state.result = null;
    this.emit();
  }

  /** 重跑调度;返回错误信息(null 表示成功) */
  runScheduler(): string | null {
    const errors = this.state.issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      return `存在 ${errors.length} 个 error 级校验问题,请先修复再排程`;
    }
    try {
      this.state.result = new Scheduler(this.state.data).buildSchedule(this.state.activities);
      this.emit();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}

const POSTPONE_LABELS: Record<PostponePolicy, string> = {
  [PostponePolicy.None]: '不顺延',
  [PostponePolicy.WithinWindow]: '窗口内顺延',
  [PostponePolicy.NextAvailable]: '窗口外顺延到上限',
};

export function createInitialState(): EditorState {
  const persisted = loadState();
  if (persisted) {
    return {
      data: persisted.data,
      activities: persisted.activities,
      result: null,
      issues: [],
      selectedEventId: null,
    };
  }
  // 首次打开:一份可直接上手的最小示例
  const data: GameData = {
    config: {
      totalDays: 360,
      slotsPerDay: 4,
      locationIds: ['教室', '图书馆', '操场', '咖啡厅'],
      characterIds: ['林夏', '陈屿', '周然'],
    },
    events: [
      {
        id: 'evt_demo_1',
        title: '清晨的图书馆',
        earliestDay: 0,
        deadlineDay: 6,
        slot: 1,
        locationId: '图书馆',
        characterIds: ['林夏'],
        condition: { kind: 'const', value: true },
        priority: 5,
        tieBreakWeight: 2,
        postpone: PostponePolicy.WithinWindow,
        maxPostponeCount: 8,
        note: '示例事件:可改条件/优先级试试仲裁',
      },
      {
        id: 'evt_demo_2',
        title: '操场偶遇',
        earliestDay: 2,
        deadlineDay: 10,
        slot: null,
        locationId: '操场',
        characterIds: ['陈屿'],
        condition: { kind: 'weekday', days: [0, 2, 4] },
        priority: 3,
        tieBreakWeight: 0,
        postpone: PostponePolicy.NextAvailable,
        latestDelayDay: 20,
      },
    ],
    routines: [
      {
        id: 'rt_demo_1',
        characterId: '林夏',
        day: 0,
        slot: 1,
        locationId: '图书馆',
        movable: true,
        movePolicy: MovePolicy.Nearest,
        maxBackwardDays: 5,
        maxForwardDays: 5,
        dropPolicy: DropPolicy.Drop,
      },
    ],
  };
  return { data, activities: [], result: null, issues: [], selectedEventId: null };
}

export { POSTPONE_LABELS };
