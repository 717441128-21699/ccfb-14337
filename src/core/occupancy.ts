import type { Day, EntityId, SlotId } from './types.js';

/**
 * 资源占用矩阵。
 *
 * 两类资源各自一张扁平 Int32Array:
 *   - 角色资源:(character × day × slot),一个角色同一时段只能在一个地点
 *   - 地点资源:(location × day × slot),同一地点同一时段容量为 1
 *
 * ownerRef 编码(零分配、O(1) 查空/落位):
 *   0    空闲
 *   > 0  角色作息条目占用,值 = placement 下标 + 1
 *   -1   玩家行程占用(最高优先级,不可被事件/作息覆盖)
 *   -2   事件占用
 */
export const OWNER_FREE = 0;
export const OWNER_PLAYER = -1;
export const OWNER_EVENT = -2;

export class Occupancy {
  readonly days: number;
  readonly slots: number;
  private readonly charCount: number;
  private readonly locCount: number;
  private readonly char: Int32Array;
  private readonly loc: Int32Array;

  constructor(charCount: number, locCount: number, days: number, slots: number) {
    this.charCount = charCount;
    this.locCount = locCount;
    this.days = days;
    this.slots = slots;
    this.char = new Int32Array(charCount * days * slots);
    this.loc = new Int32Array(locCount * days * slots);
  }

  private charIndex(ci: number, day: Day, slot: SlotId): number {
    return (ci * this.days + day) * this.slots + slot;
  }

  private locIndex(li: number, day: Day, slot: SlotId): number {
    return (li * this.days + day) * this.slots + slot;
  }

  getCharOwner(ci: number, day: Day, slot: SlotId): number {
    return this.char[this.charIndex(ci, day, slot)]!;
  }

  getLocOwner(li: number, day: Day, slot: SlotId): number {
    return this.loc[this.locIndex(li, day, slot)]!;
  }

  setCharOwner(ci: number, day: Day, slot: SlotId, owner: number): void {
    this.char[this.charIndex(ci, day, slot)] = owner;
  }

  setLocOwner(li: number, day: Day, slot: SlotId, owner: number): void {
    this.loc[this.locIndex(li, day, slot)] = owner;
  }

  /** 事件视角:地点与所有相关角色全部空闲才可落位 */
  canPlaceEvent(
    charIndices: readonly number[],
    locIndex: number,
    day: Day,
    slot: SlotId,
  ): boolean {
    if (this.loc[this.locIndex(locIndex, day, slot)] !== OWNER_FREE) return false;
    for (const ci of charIndices) {
      if (this.char[this.charIndex(ci, day, slot)] !== OWNER_FREE) return false;
    }
    return true;
  }

  placeEvent(
    charIndices: readonly number[],
    locIndex: number,
    day: Day,
    slot: SlotId,
  ): void {
    this.loc[this.locIndex(locIndex, day, slot)] = OWNER_EVENT;
    for (const ci of charIndices) {
      this.char[this.charIndex(ci, day, slot)] = OWNER_EVENT;
    }
  }

  /**
   * 玩家行程视角的占用检查。
   * 返回 null 表示可落位;否则返回不可让开的占用方编码(OWNER_PLAYER / OWNER_EVENT / 正数=锁定作息)。
   * 可移动作息的占用会通过 movablePlacementRefs 报出,由调用方负责迁移。
   */
  checkPlayerActivity(
    charIndices: readonly number[],
    locIndex: number,
    day: Day,
    slot: SlotId,
    isRoutineMovable: (placementRef: number) => boolean,
  ): { blockedBy: number } | { movableRoutineRefs: number[] } | null {
    const movableRoutineRefs: number[] = [];
    const locOwner = this.loc[this.locIndex(locIndex, day, slot)]!;
    if (locOwner !== OWNER_FREE) {
      if (locOwner > 0 && isRoutineMovable(locOwner)) movableRoutineRefs.push(locOwner);
      else return { blockedBy: locOwner };
    }
    for (const ci of charIndices) {
      const owner = this.char[this.charIndex(ci, day, slot)]!;
      if (owner === OWNER_FREE) continue;
      if (owner > 0 && isRoutineMovable(owner)) {
        if (!movableRoutineRefs.includes(owner)) movableRoutineRefs.push(owner);
      } else {
        // owner 可能是 OWNER_PLAYER / OWNER_EVENT(负数)或不可移动作息(正数),
        // 调用方用 describeBlocker 区分,绝不能当下标访问
        return { blockedBy: owner };
      }
    }
    return movableRoutineRefs.length > 0 ? { movableRoutineRefs } : null;
  }

  placePlayer(
    charIndices: readonly number[],
    locIndex: number,
    day: Day,
    slot: SlotId,
  ): void {
    this.loc[this.locIndex(locIndex, day, slot)] = OWNER_PLAYER;
    for (const ci of charIndices) {
      this.char[this.charIndex(ci, day, slot)] = OWNER_PLAYER;
    }
  }

  /** 释放某条作息在矩阵里的全部占用 */
  clearRoutine(placementRef: number): void {
    fillWhere(this.char, placementRef, OWNER_FREE);
    fillWhere(this.loc, placementRef, OWNER_FREE);
  }

  /** 释放某事件的占用(按资源位置精确释放) */
  clearEvent(
    charIndices: readonly number[],
    locIndex: number,
    day: Day,
    slot: SlotId,
  ): void {
    this.loc[this.locIndex(locIndex, day, slot)] = OWNER_FREE;
    for (const ci of charIndices) {
      const idx = this.charIndex(ci, day, slot);
      if (this.char[idx] === OWNER_EVENT) this.char[idx] = OWNER_FREE;
    }
  }
}

function fillWhere(arr: Int32Array, target: number, replacement: number): void {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === target) arr[i] = replacement;
  }
}

/** 确定性字符串哈希(FNV-1a 32 位),用于同优先级事件的稳定随机决胜 */
export function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32 位 FNV prime,用 Math.imul 保持整数语义
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 实体 id -> 紧凑下标的双向表,矩阵用下标、业务层用 id */
export class IdIndex {
  private readonly toIndex = new Map<EntityId, number>();
  readonly ids: EntityId[] = [];

  constructor(ids: readonly EntityId[]) {
    ids.forEach((id, i) => {
      this.toIndex.set(id, i);
      this.ids.push(id);
    });
  }

  index(id: EntityId): number {
    const i = this.toIndex.get(id);
    if (i === undefined) throw new Error(`未知实体 id: ${id}`);
    return i;
  }

  id(index: number): EntityId {
    return this.ids[index]!;
  }

  get size(): number {
    return this.ids.length;
  }
}
