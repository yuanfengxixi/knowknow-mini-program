// 笔记排序 —— 唯一规则：按标题排，数字打头的在最前，其余中英文合成一条 A→Z（微信通讯录那样）。
// 不看创建时间、周期时间这些用户看不见的字段：看到什么标题就排在什么位置，顺序永远可预期。
//
// ⚠️ 这份逻辑与 cloudfunctions/list-notes/index.js 里的 sortNotes 必须保持一致。
// 前端这份只用于本地乐观更新（拖动笔记换文件夹时立刻归位，免得先落到末尾、刷新又跳走）；
// 云端那份是权威结果。改其中一处，另一处要同步改。

// 每个边界字是该字母下拼音最靠前的（一声优先），否则像"哈(hā)"会被误判到上一组。
// 拼音里没有 I / U / V 打头的字。
const PINYIN_BOUNDARY = ['啊', '八', '嚓', '咑', '婀', '发', '旮', '哈', '丌', '喀', '垃', '妈', '拏', '噢', '趴', '七', '然', '仨', '他', '屲', '夕', '丫', '匝'];
const PINYIN_LETTER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'W', 'X', 'Y', 'Z'];

// 运行时若缺完整 ICU 数据，localeCompare('zh') 会悄悄退化成 Unicode 码点序（中文就不按拼音了）。
// 开机探测一次：拼音序下 '啊'(a) 在 '中'(zh) 之前，码点序下正好相反。
const zhCollator = (function () {
  try {
    const c = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' });
    if (c.compare('啊', '中') < 0) return c;
    console.warn('note-sort: 运行时缺少中文 ICU 数据，标题排序降级为码点序');
  } catch (e) {
    console.warn('note-sort: Intl.Collator 不可用，标题排序降级为码点序', e && e.message);
  }
  return null;
})();

/**
 * 标题 → 排序键。中文开头的加上拼音首字母前缀，其余（数字/英文）原样用。
 * 加前缀是为了让 "Anthropic" 和 "阿里" 落进同一个 A 组，中英文合成一条 A→Z，
 * 而不是汉字排一堆、英文排另一堆分成两截。
 */
function sortKey(title) {
  const t = String(title || '').trim();
  const ch = t.charAt(0);
  if (!zhCollator || !/[一-龥]/.test(ch)) return t;
  let letter = 'A';
  for (let i = PINYIN_BOUNDARY.length - 1; i >= 0; i--) {
    if (zhCollator.compare(ch, PINYIN_BOUNDARY[i]) >= 0) { letter = PINYIN_LETTER[i]; break; }
  }
  return letter + t;
}

function compareKey(a, b) {
  if (zhCollator) return zhCollator.compare(a, b);
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return 0;
}

/** 原地排序一组笔记（元素需带 title）。返回同一个数组，方便链式调用。 */
function sortNotes(arr) {
  if (!Array.isArray(arr)) return arr;
  // 排序键预先算好，避免每次两两比较都重算一遍拼音首字母
  const keyed = arr.map((n) => ({ n: n, k: sortKey(n && n.title) }));
  keyed.sort((a, b) => {
    // 数字开头 = 第 0 组（排最前），其余 = 第 1 组
    const ga = /^\d/.test(a.k) ? 0 : 1;
    const gb = /^\d/.test(b.k) ? 0 : 1;
    if (ga !== gb) return ga - gb;
    return compareKey(a.k, b.k);
  });
  keyed.forEach((item, i) => { arr[i] = item.n; });
  return arr;
}

module.exports = { sortNotes };
