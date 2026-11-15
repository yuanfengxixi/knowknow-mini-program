const XLSX = require('xlsx');
const mammoth = require('mammoth');
const iconv = require('iconv-lite');

const MAX_TEXT_CHARS = 20000; // 防止超长文本进入后续链路，拖高内存和模型输入成本。
const MAX_SHEET_ROWS = 500; // 防止大表格生成巨量中间字符串。
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 防止单文件耗尽云函数 512MB 内存。
const PREVIEW_HEADER_LIMIT = 6; // 防止列名过多把聊天预览撑成多行。
const SUPPORTED_EXTENSIONS = new Set(['xlsx', 'xls', 'csv', 'docx', 'txt', 'md']);
const SHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'csv']);
const PLAIN_EXTENSIONS = new Set(['txt', 'md']);

function failure(code, message) {
  return { ok: false, code, message };
}

function getExtension(fileName) {
  const match = String(fileName || '').toLowerCase().match(/\.([^.]+)$/);
  return match ? match[1] : '';
}

function isSupportedFileName(fileName) {
  return SUPPORTED_EXTENSIONS.has(getExtension(fileName));
}

function decodeCsv(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!utf8) return '';
  // \u5408\u6CD5 UTF-8\uFF08\u542B\u7EAF ASCII\uFF09\u89E3\u7801\u4E0D\u4F1A\u4EA7\u751F\u4EFB\u4F55 U+FFFD\uFF1B\u51FA\u73B0\u5373\u8BF4\u660E\u7F16\u7801\u4E0D\u5BF9\u3002
  // \u4E0D\u80FD\u6309\u5360\u6BD4\u8BBE\u9608\u503C\uFF1A\u56FD\u5185 Excel \u5BFC\u51FA\u7684\u6D41\u6C34 CSV \u5E38\u662F\u51E0\u5343\u4E2A\u6570\u5B57\u5B57\u7B26 + \u8868\u5934\u51E0\u4E2A\u4E2D\u6587\uFF0C
  // \u4E71\u7801\u5B57\u7B26\u5360\u6BD4\u4E0D\u5230 1%\uFF0C\u6309\u6BD4\u4F8B\u5224\u4F1A\u8BA9\u8868\u5934\u6C38\u8FDC\u4FDD\u6301\u4E71\u7801\u3002
  const utf8Bad = (utf8.match(/\uFFFD/g) || []).length;
  if (utf8Bad === 0) return utf8;
  const gbk = iconv.decode(buffer, 'gb18030');
  const gbkBad = (gbk.match(/\uFFFD/g) || []).length;
  return gbkBad < utf8Bad ? gbk : utf8;
}

function readWorkbook(buffer, extension) {
  if (extension === 'csv') {
    return XLSX.read(decodeCsv(buffer), { type: 'string', raw: true });
  }
  return XLSX.read(buffer, { type: 'buffer', raw: true });
}

function cellText(sheet, row, col) {
  const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
  return cell ? XLSX.utils.format_cell(cell) : '';
}

function sheetCsv(sheet, range) {
  const limitedSheet = Object.assign({}, sheet, {
    '!ref': XLSX.utils.encode_range(range),
  });
  return XLSX.utils.sheet_to_csv(limitedSheet, {
    FS: '\t',
    RS: '\n',
    blankrows: true,
  }).replace(/\n+$/, '');
}

function parseSheetBuffer(buffer, extension) {
  const workbook = readWorkbook(buffer, extension);
  const sheets = [];
  const textParts = [];
  let rowTruncated = false;

  for (const name of workbook.SheetNames || []) {
    const sheet = workbook.Sheets[name];
    const ref = sheet && sheet['!ref'];
    if (!ref) {
      sheets.push({ name, rows: 0, cols: 0, headers: [] });
      continue;
    }

    const sourceRange = XLSX.utils.decode_range(ref);
    const totalRows = sourceRange.e.r - sourceRange.s.r + 1;
    const dataRows = Math.max(0, totalRows - 1);
    const cols = sourceRange.e.c - sourceRange.s.c + 1;
    const headers = [];
    for (let col = sourceRange.s.c; col <= sourceRange.e.c; col++) {
      headers.push(cellText(sheet, sourceRange.s.r, col));
    }

    // 防止大表格在云函数内生成巨量中间字符串，同时首行表头始终保留。
    const includedDataRows = Math.min(dataRows, MAX_SHEET_ROWS);
    const outputRange = {
      s: sourceRange.s,
      e: {
        r: sourceRange.s.r + includedDataRows,
        c: sourceRange.e.c,
      },
    };
    const csv = sheetCsv(sheet, outputRange);
    if (csv) textParts.push(`【工作表：${name}】\n${csv}`);
    if (dataRows > MAX_SHEET_ROWS) rowTruncated = true;
    sheets.push({ name, rows: dataRows, cols, headers });
  }

  return { text: textParts.join('\n\n'), sheets, rowTruncated };
}

function applyTextLimit(text) {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  // 防止超长文档继续进入后续链路，控制内存和模型输入规模。
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

function appendTruncated(preview, truncated) {
  return truncated ? `${preview}（内容较长，只读了前一部分）` : preview;
}

function sheetPreview(sheets, truncated) {
  const primary = sheets.find((sheet) => sheet.rows > 0 || sheet.headers.some(Boolean));
  if (!primary) return '文件是空的';
  const headers = primary.headers.filter(Boolean).slice(0, PREVIEW_HEADER_LIMIT);
  let preview = `${sheets.length} 个工作表，${primary.name} ${primary.rows} 行`;
  if (headers.length) preview += `，列有 ${headers.join('/')}`;
  return appendTruncated(preview, truncated);
}

function documentPreview(extension, chars, truncated) {
  if (chars === 0) return '文件是空的';
  const label = extension === 'docx'
    ? 'Word 文档'
    : extension === 'md' ? 'Markdown 文档' : '文本文件';
  return appendTruncated(`${label}，约 ${chars} 字`, truncated);
}

async function parseBuffer(buffer, fileName) {
  const extension = getExtension(fileName);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return failure('UNSUPPORTED_TYPE', '不支持该文件格式');
  }
  if (!Buffer.isBuffer(buffer)) return failure('PARSE_FAILED', '文件内容无效');
  if (buffer.length > MAX_FILE_BYTES) {
    return failure('FILE_TOO_LARGE', '文件超过 10MB 限制');
  }
  if (buffer.length === 0) {
    const kind = SHEET_EXTENSIONS.has(extension)
      ? 'sheet' : extension === 'docx' ? 'doc' : 'plain';
    const meta = { kind, chars: 0 };
    if (kind === 'sheet') meta.sheets = [];
    return { ok: true, text: '', truncated: false, meta, preview: '文件是空的' };
  }

  try {
    if (SHEET_EXTENSIONS.has(extension)) {
      const parsed = parseSheetBuffer(buffer, extension);
      const limited = applyTextLimit(parsed.text);
      const truncated = parsed.rowTruncated || limited.truncated;
      return {
        ok: true,
        text: limited.text,
        truncated,
        meta: { kind: 'sheet', sheets: parsed.sheets, chars: parsed.text.length },
        preview: sheetPreview(parsed.sheets, truncated),
      };
    }

    let text;
    if (extension === 'docx') {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value || '';
    } else if (PLAIN_EXTENSIONS.has(extension)) {
      text = buffer.toString('utf8');
    }
    const limited = applyTextLimit(text || '');
    return {
      ok: true,
      text: limited.text,
      truncated: limited.truncated,
      meta: {
        kind: extension === 'docx' ? 'doc' : 'plain',
        chars: (text || '').length,
      },
      preview: documentPreview(extension, (text || '').length, limited.truncated),
    };
  } catch (e) {
    console.warn('parse-file parse failed:', e.message);
    return failure('PARSE_FAILED', '文件解析失败');
  }
}

module.exports = {
  applyTextLimit,
  decodeCsv,
  getExtension,
  isSupportedFileName,
  parseBuffer,
  MAX_FILE_BYTES,
  MAX_SHEET_ROWS,
  MAX_TEXT_CHARS,
};
