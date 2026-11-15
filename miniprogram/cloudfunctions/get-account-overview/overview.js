const { ACCOUNT_OVERVIEW, BEIJING_OFFSET_MS } = require('./_shared/constants.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const COLORS = ['#83bc8d', '#b4d8ba', '#d2e7d5', '#e1eee2', '#edf4ed'];

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (value && Number.isFinite(value._seconds)) return value._seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function dayNumber(ms) { return Math.floor((ms + BEIJING_OFFSET_MS) / DAY_MS); }
function dayKey(day) { return new Date(day * DAY_MS).toISOString().slice(0, 10); }
function hourOf(ms) { return new Date(ms + BEIJING_OFFSET_MS).getUTCHours(); }

function folderName(folder) {
  return String(folder || '/').split('/').filter(Boolean)[0] || '未分类';
}

function buildHeatmap(notes, today) {
  const counts = new Map();
  notes.forEach((note) => counts.set(dayNumber(note.ms), (counts.get(dayNumber(note.ms)) || 0) + 1));
  const first = today - ACCOUNT_OVERVIEW.HEAT_DAYS + 1;
  const recent = Array.from({ length: ACCOUNT_OVERVIEW.HEAT_DAYS }, (_, index) => ({
    day: first + index,
    count: counts.get(first + index) || 0,
  }));
  const max = Math.max(0, ...recent.map((item) => item.count));
  return recent.map((item) => ({
    date: dayKey(item.day),
    count: item.count,
    level: item.count && max ? Math.max(1, Math.ceil(item.count / max * 4)) : 0,
  }));
}

function currentStreak(notes, today) {
  const days = new Set(notes.map((note) => dayNumber(note.ms)));
  let cursor = days.has(today) ? today : today - 1;
  let streak = 0;
  while (days.has(cursor)) { streak += 1; cursor -= 1; }
  return streak;
}

function buildCategories(notes) {
  const counts = new Map();
  notes.forEach((note) => {
    const name = folderName(note.folder);
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  let rows = Array.from(counts, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
  if (rows.length > ACCOUNT_OVERVIEW.MAX_CATEGORIES) {
    const kept = rows.slice(0, ACCOUNT_OVERVIEW.MAX_CATEGORIES - 1);
    kept.push({ name: '其他', count: rows.slice(ACCOUNT_OVERVIEW.MAX_CATEGORIES - 1).reduce((sum, item) => sum + item.count, 0) });
    rows = kept;
  }
  let used = 0;
  return rows.map((item, index) => {
    const percent = index === rows.length - 1 ? 100 - used : Math.round(item.count / notes.length * 100);
    used += percent;
    return { ...item, percent, color: COLORS[index] };
  });
}

function buildHours(notes) {
  const counts = Array(24).fill(0);
  notes.forEach((note) => { counts[hourOf(note.ms)] += 1; });
  const max = Math.max(0, ...counts);
  const peak = max ? counts.indexOf(max) : -1;
  return {
    peakHour: peak < 0 ? '--:--' : `${String(peak).padStart(2, '0')}:00`,
    hours: counts.map((count, hour) => ({
      hour,
      count,
      height: max ? Math.max(5, Math.round(count / max * 94)) : 5,
      hot: count > 0 && count >= max * .75,
    })),
    timeInsight: timeInsight(peak),
  };
}

function timeInsight(hour) {
  if (hour < 0) return '记下第一条内容后，这里会出现你的记录时段。';
  if (hour < 6) return '🌙 深夜，是你最容易产生想法的时候。';
  if (hour < 12) return '☀️ 上午，是你最常记录的时候。';
  if (hour < 18) return '🌤️ 下午，是你最常记录的时候。';
  return '🌙 夜晚，是你最容易产生想法的时候。';
}

function buildPersona(total, categories, streak) {
  if (!total) return { emoji: '🌱', name: '探索者型', description: '你的笔记还在慢慢积累。\n先记下一个当下真正关心的想法。' };
  const topShare = categories[0] ? categories[0].percent : 0;
  if (categories.length >= 4 && topShare < 55) return { emoji: '🐙', name: '八爪鱼型', description: '你的脑子里总是同时住着很多个想法。\n好奇、发散，喜欢把不同的东西连接起来。' };
  if (streak >= 7) return { emoji: '🌿', name: '园丁型', description: '你习惯持续照看自己的想法。\n稳定、有节奏，让知识一点点长出来。' };
  if (topShare >= 55) return { emoji: '🐋', name: '深潜者型', description: '你愿意沿着重要的事一路往深处想。\n专注、沉浸，擅长把一个主题慢慢吃透。' };
  return { emoji: '🔗', name: '连接者型', description: '你会在记录里寻找关系和线索。\n灵活、敏锐，常能把零散的内容串成一条线。' };
}

function buildOverview(rawNotes, now = Date.now()) {
  const notes = rawNotes.map((note) => ({ ...note, ms: timestamp(note.createdAt) })).filter((note) => note.ms !== null);
  const today = dayNumber(now);
  const categories = buildCategories(notes);
  const streak = currentStreak(notes, today);
  const timing = buildHours(notes);
  return {
    total: notes.length,
    streak,
    heatmap: buildHeatmap(notes, today),
    categories,
    topCategory: categories[0] ? categories[0].name : '暂无记录',
    ...timing,
    persona: buildPersona(notes.length, categories, streak),
  };
}

module.exports = { buildOverview, timestamp };
