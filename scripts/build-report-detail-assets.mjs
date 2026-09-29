import fs from 'node:fs';
import path from 'node:path';

// The admin page remains the canonical detail template. Both entry points are
// built from that source, so fields, escaping and presentation stay in sync.
export function buildReportDetailAssets(sourceDir, targetDir) {
  const html = fs.readFileSync(path.join(sourceDir, 'admin.html'), 'utf8');
  const between = (start, end) => {
    const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error(`Shared report detail source marker missing: ${start}`);
    return html.slice(a, b);
  };
  const helpers = [
    between('      function escapeHtml(', '      const REPORTER_TAG_CLASS_NAMES'),
    between('      const STORE_LABELS_BY_CHANNEL_CODE', '      const MANAGER_CHANNEL_CODE_BY_STORE'),
    between('      function renderStoreCell(', '      function renderBillAttachment('),
    between('      function renderAmountCell(', '      function setStatus('),
    between('      function desktopReportIcon(', '      function canDeleteItem('),
  ].join('\n');
  let renderer = between('      function renderDetail(report)', '      async function loadDetail(');
  renderer = renderer.slice(renderer.indexOf('        const sources'));
  renderer = renderer.replace('        elements.detailContent.innerHTML = ', '        return ');
  const js = `/* Generated from admin.html. Do not edit the generated file. */\nwindow.ExpenseReportDetail = { render(report, options = {}) {\nconst state = options; const BASE_PATH = '/expense'; const DEFAULT_TIME_ZONE = 'Asia/Shanghai';\n${helpers}\n${renderer}\n};\n`;
  // Base disclosure/attachment styles and the exact admin detail sheet rules.
  const base = between('      .source-list,', '      .pagination {').replace(/^(\s*)(\.[\w-])/gm, '$1#sourceReportDialog $2');
  const sheet = between('      /* The detail sheet has its own layout;', '      /* Desktop list styling').replaceAll('#detailModal', '#sourceReportDialog');
  const css = `${base}\n${sheet}\n#sourceReportDialog { --ink-soft:var(--soft); --surface-strong:var(--surface); --surface-image:var(--surface); --subtle-border:var(--line); --radius-lg:20px; position:fixed; inset:0; margin:0; width:100vw; max-width:100vw; height:100vh; height:100dvh; max-height:100dvh; border:0; background:transparent; color:var(--ink); }\n#sourceReportDialog:not([open]){display:none}\n#sourceReportDialog::backdrop{background:rgba(28,28,30,.4)}\n#sourceReportDialog .source-text{display:block;margin:0;gap:0}\n#sourceReportDialog .column-amount-value{display:grid;line-height:1.35}\n#sourceReportDialog .detail-summary-amount .column-amount-number{display:block}\n#sourceReportDialog .button-primary{color:white;background:var(--brand);border-color:var(--brand)}\n#sourceReportDialog .detail-note .note-pill{color:#9a6700;background:rgba(255,204,0,.18)}\n#sourceReportDialog .detail-note .note-pill-farm{color:#15803d;background:rgba(34,197,94,.14)}\n:root[data-theme=dark] #sourceReportDialog .detail-note .note-pill{color:#ffc266}\n:root[data-theme=dark] #sourceReportDialog .detail-note .note-pill-farm{color:#69dc8d}\n`;
  fs.writeFileSync(path.join(targetDir, 'monthly', 'report-detail.js'), js);
  fs.writeFileSync(path.join(targetDir, 'monthly', 'report-detail.css'), css);
}
