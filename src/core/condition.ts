import type { CompareOp, ConditionContext, ConditionExpr } from './types.js';

/**
 * 触发条件解释器。
 * 纯函数、无副作用;条件上下文由游戏侧提供快照。
 */
export function evaluateCondition(expr: ConditionExpr, ctx: ConditionContext): boolean {
  switch (expr.kind) {
    case 'all':
      return expr.of.every((sub) => evaluateCondition(sub, ctx));
    case 'any':
      return expr.of.some((sub) => evaluateCondition(sub, ctx));
    case 'not':
      return !evaluateCondition(expr.expr, ctx);
    case 'stat':
      return compare(ctx.stats[expr.stat] ?? 0, expr.op, expr.value);
    case 'affection':
      return compare(ctx.affection[expr.character] ?? 0, expr.op, expr.value);
    case 'flag':
      return (ctx.flags[expr.flag] ?? false) === expr.value;
    case 'item':
      return compare(ctx.items[expr.item] ?? 0, expr.op, expr.value);
    case 'weekday':
      // 六天一星期
      return expr.days.includes(((ctx.day % 6) + 6) % 6);
    case 'eventState':
      return (ctx.eventStates[expr.event] ?? 'pending') === expr.state;
    case 'const':
      return expr.value;
    default: {
      // 穷尽性检查:新增条件类型时这里会编译报错
      const _exhaustive: never = expr;
      throw new Error(`未知条件类型: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function compare(left: number, op: CompareOp, right: number): boolean {
  switch (op) {
    case '>=': return left >= right;
    case '<=': return left <= right;
    case '>':  return left > right;
    case '<':  return left < right;
    case '==': return left === right;
    case '!=': return left !== right;
    default: {
      const _exhaustive: never = op;
      throw new Error(`未知比较符: ${String(_exhaustive)}`);
    }
  }
}

/** 静态扫描条件里引用到的事件 id,用于校验悬空引用与依赖环检测 */
export function collectReferencedEventIds(expr: ConditionExpr, out: Set<string>): void {
  switch (expr.kind) {
    case 'all':
    case 'any':
      expr.of.forEach((sub) => collectReferencedEventIds(sub, out));
      return;
    case 'not':
      collectReferencedEventIds(expr.expr, out);
      return;
    case 'eventState':
      out.add(expr.event);
      return;
    default:
      return;
  }
}
