import type { ValidationIssue } from '../../core/index.js';

export function renderValidationPanel(slot: HTMLElement, issues: ValidationIssue[]): void {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const infos = issues.filter((i) => i.severity === 'info');

  const badge = (count: number, label: string, cls: string): string =>
    `<span class="badge ${cls}">${label} ${count}</span>`;

  const rows = issues
    .map((i) => {
      const entity = i.entityId ? `<code>${escapeHtml(i.entityId)}</code>` : '';
      const field = i.field ? ` <span class="field">${escapeHtml(i.field)}</span>` : '';
      return `<li class="issue ${i.severity}">${entity}${field} <span>${escapeHtml(i.message)}</span> <em>${i.code}</em></li>`;
    })
    .join('');

  slot.innerHTML = `
    <div class="validation-bar ${errors.length ? 'has-error' : ''}">
      <div class="badges">
        ${badge(errors.length, 'error', 'err')}
        ${badge(warnings.length, 'warning', 'warn')}
        ${badge(infos.length, 'info', 'info')}
      </div>
      ${issues.length === 0 ? '<p class="clean">✓ 校验通过,没有发现问题</p>' : `<ul class="issue-list">${rows}</ul>`}
    </div>
  `;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
