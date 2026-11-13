/**
 * 按 RFC 4180 解析 CSV / TSV：字段可以用双引号包起来，里面可以有分隔符和换行，`""` 表示一个双引号。
 * 宽松处理：引号没闭合时取到结尾；闭合引号后面到分隔符之前的字符照常并入字段；空行跳过。
 */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  // 字段是否以引号开头（引号只在字段开头才有特殊含义）
  let fresh = true;
  const endRow = () => {
    row.push(field);
    // 只有一个空字段的行是空行
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    field = '';
    fresh = true;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (c === '"' && fresh) {
      quoted = true;
      fresh = false;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
      fresh = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += c;
      fresh = false;
    }
  }
  if (!fresh || row.length) endRow();
  return rows;
}

/** CSV / TSV 源码 → 表格：第一行是表头，每行补齐到最多的列数 */
export function renderDelimitedTable(source: string, delimiter: string): HTMLTableElement {
  const rows = parseDelimited(source, delimiter);
  const width = Math.max(0, ...rows.map((r) => r.length));
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  rows.forEach((cells, r) => {
    const tr = document.createElement('tr');
    for (let c = 0; c < width; c++) {
      const cell = document.createElement(r === 0 ? 'th' : 'td');
      cell.textContent = cells[c] ?? '';
      tr.append(cell);
    }
    (r === 0 ? thead : tbody).append(tr);
  });
  if (thead.childElementCount) table.append(thead);
  if (tbody.childElementCount) table.append(tbody);
  return table;
}

/** 代码块语言对应的分隔符：csv 是逗号，tsv 是制表符；其他语言返回 null */
export function delimiterFor(lang: string | null | undefined): string | null {
  const l = lang?.toLowerCase();
  return l === 'csv' ? ',' : l === 'tsv' ? '\t' : null;
}

/** 把 CSV / TSV 表格渲染进元素；内容为空时显示一行淡色的语言名，方便点开编辑 */
export function renderCsv(el: HTMLElement, source: string, delimiter: string) {
  const table = renderDelimitedTable(source, delimiter);
  if (table.childElementCount) el.replaceChildren(table);
  else {
    const hint = document.createElement('code');
    hint.className = 'zy-raw-hint';
    hint.textContent = delimiter === '\t' ? 'tsv' : 'csv';
    el.replaceChildren(hint);
  }
}
