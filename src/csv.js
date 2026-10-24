import { AppError } from './domain.js';
export function parseCsv(raw) {
  if (typeof raw !== 'string') throw new AppError('CSV 内容必须为文字');
  const source = raw.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const push = () => { row.push(cell); cell = ''; closed = false; };
  for (let i=0; i<source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"') {
      if (cell || closed) throw new AppError('CSV 引号格式错误');
      quoted = true;
    } else if (c === ',') push();
    else if (c === '\n' || c === '\r') { if (c === '\r' && source[i+1] === '\n') i++; push(); if (row.some(x=>x!=='')) rows.push(row); row = []; }
    else { if (closed) throw new AppError('CSV 引号后出现非法字符'); cell += c; }
  }
  if (quoted) throw new AppError('CSV 引号未闭合');
  if (cell || row.length || closed) { push(); if(row.some(x=>x!=='')) rows.push(row); }
  if (!rows.length) throw new AppError('CSV 为空');
  const headers = rows.shift().map(x=>x.trim());
  if (headers.some(x=>!x) || new Set(headers).size !== headers.length) throw new AppError('CSV 表头为空或重复');
  return rows.map((r,i)=>{ if(r.length !== headers.length) throw new AppError(`CSV 第 ${i+2} 行列数错误`); return Object.fromEntries(headers.map((h,j)=>[h,r[j]])); });
}
export function writeCsv(rows, headers) {
  const escape = value => {
    let s = value == null ? '' : String(value);
    if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"','""') + '"' : s;
  };
  return '\uFEFF' + [headers.map(escape).join(','),...rows.map(r=>headers.map(h=>escape(r[h])).join(','))].join('\r\n');
}
