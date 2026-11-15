// 云函数共享常量唯一来源（配额 / 模型 / 价格 / 集合名 / 目录）。
// ⚠️ 部署机制：云函数是独立部署包，本目录不会自动带上——
// deploy.js 部署前会自动把 _shared 拷进每个函数目录（.deploy/sync-shared.js），
// 本地改完 _shared 后如需跑离线测试，也先跑一次 node .deploy/sync-shared.js。

/** 配额唯一来源：任务接收和事务内扣减必须共用同一组参数。 */
const QUOTA = {
  MODE: 'paid',          // 'off' 不限 | 'beta' 灰度免费只防刷 | 'paid' 正式付费
  BETA_DAILY_LIMIT: 30,  // 灰度期每人每天上限
  TRIAL_NOTE_LIMIT: 30,  // 免费写入总次数，避免达到额度后继续产生付费模型成本
  DAILY_NOTE_LIMIT: 100, // 旧日配额字段只用于灰度防刷，不再作为会员权益
};

/** 月卡商品与权益真值。真实订单产生后不得修改原商品语义，调价需新增 productId。 */
const MEMBERSHIP = Object.freeze({
  PRODUCT_ID: 'monthly_credits_v2',
  TITLE: '知知月卡',
  AMOUNT_FEN: 1990,
  CURRENCY: 'CNY',
  POINTS_PER_PERIOD: 10000,
  POINTS_PER_CNY_COST: 1000,
  LOW_CREDIT_THRESHOLD: 1000, // 只在本期积分进入最后 10% 时提醒，避免频繁打扰
  ORDER_EXPIRE_MS: 15 * 60 * 1000,
});

// 网站登录必须短时完成；会话到期后强制重新经微信确认，避免长期失窃 Cookie 访问笔记。
const WEB = Object.freeze({ LOGIN_TTL_MS: 10 * 60 * 1000, SESSION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  MAX_NOTE_TITLE: 80, MAX_NOTE_CONTENT: 200000 });

// 虚拟支付查单最慢 12 秒，限制每轮数量以免 90 秒定时函数超时后遗漏补偿。
const VIRTUAL_PAYMENT = Object.freeze({ CREATING_BATCH: 5, PENDING_BATCH: 2, DELIVERY_BATCH: 2 });

const MODELS = {
  FLASH: 'deepseek-flash',
};

/** DeepSeek API 端点（原来 6 个云函数各抄一份字面量，改端点要手改 6 处） */
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

/** DeepSeek 价格（元 / 百万 token）；供应商调价时更新此唯一价格表。 */
// 2026 年官方放假区间。缺失新年日历时 usage.js 按闲时计价并告警，防止多扣用户。
const PRICING_HOLIDAYS = { 2026: [
  ['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'],
  ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07'],
] };
const PRICE_PER_M = {
  'deepseek-flash': {
    offPeak: { cacheHitInput: 0.02, cacheMissInput: 1, output: 4 },
    peak: { cacheHitInput: 0.04, cacheMissInput: 2, output: 8 },
  },
};

/** 数据库集合名：新代码禁止写字面量，存量代码在触及时分批收口。 */
const COL = {
  AGENT_SESSIONS: 'agent_sessions',
  TASK_EFFECTS: 'task_effects',
  TASK_QUEUE: 'task_queue',
  TASKS: 'tasks',
  TASK_COUNTERS: 'task_counters',
  NOTES: 'notes',
  USERS: 'users',
  FOLDERS: 'folders',
  NOTE_VECTORS: 'note_vectors',
  MEMORY_CARDS: 'memory_cards',
  MEMORY_CHANGES: 'memory_changes',
  MEMORY_BACKUPS: 'memory_backups',
  USAGE_LOG: 'usage_log',
  SUBSCRIPTIONS: 'subscriptions',
  WEB_SESSIONS: 'web_sessions',
};

/** 报告目录（原来 4 份清单散在 7 个文件） */
const REPORT_FOLDERS = ['/日常/日报', '/日常/周报', '/日常/月报', '/日常/年报'];

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 回收站保留天数（真值；前端 utils/constants.js 的同名常量只用于文案） */
const RECYCLE_RETAIN_DAYS = 30;

// 个人中心概览分页读取全部有效笔记，避免单次查询超 CloudBase 上限。
const ACCOUNT_OVERVIEW = { PAGE_SIZE: 100, HEAT_DAYS: 30, MAX_CATEGORIES: 5 };

/** 防止自动维护长期累积重复事实并持续放大每轮模型上下文；达到上限后只合并、更新或删除旧卡。 */
const MEMORY = Object.freeze({ MAX_CARDS: 50, MAX_CONTENT: 1000 });

module.exports = { QUOTA, MODELS, DEEPSEEK_BASE_URL, PRICE_PER_M, PRICING_HOLIDAYS, COL, REPORT_FOLDERS, BEIJING_OFFSET_MS,
  RECYCLE_RETAIN_DAYS, ACCOUNT_OVERVIEW, MEMBERSHIP, VIRTUAL_PAYMENT, WEB, MEMORY };
