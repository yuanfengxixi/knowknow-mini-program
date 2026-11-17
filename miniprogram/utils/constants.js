// 前端常量唯一来源。云函数名、action 枚举、错误码文案等一律从这里 import，
// 禁止在页面里写字符串字面量（防止改一处漏一处）。

/** 部署者可填自己的 CloudBase 环境 ID；留空时使用开发者工具当前选择的环境。 */
const CLOUD_ENV_ID = '';

/** 云函数名 */
const FN = {
  TASK_SERVICE: 'task-service',
  MANAGE_KB: 'manage-kb',
  LIST_NOTES: 'list-notes',
  EXPORT_DATA: 'export-data',
  DELETE_NOTE: 'delete-note',
  RESTORE_NOTE: 'restore-note',
  LIST_DELETED: 'list-deleted',
  UPDATE_PREFERENCES: 'update-preferences',
  INIT_FOLDERS: 'init-folders',
  PARSE_FILE: 'parse-file',
  GET_ACCOUNT_OVERVIEW: 'get-account-overview',
  PAYMENT_SERVICE: 'payment-service',
};

/** manage-kb 的 action 枚举 */
const KB = {
  CREATE_FOLDER: 'createFolder',
  CREATE_NOTE: 'createNote',
  MOVE_NOTE: 'moveNote',
  MOVE_FOLDER: 'moveFolder',
  RENAME_FOLDER: 'renameFolder',
  RENAME_NOTE: 'renameNote',
  DELETE_FOLDER: 'deleteFolder',
  BATCH_DELETE: 'batchDelete',
};

/** 任务回执超时和轮询间隔（毫秒），与模型生成时长解耦。 */
const TIMEOUT = { RECEIPT: 5000, POLL_INTERVAL: 3000 };

/** 云存储路径前缀 */
const UPLOAD_PREFIX = {
  NOTE_IMAGES: 'note-images/',
  NOTE_FILES: 'note-files/',
};

/** 文档上传限制。EXTENSIONS 是校验用的全集，GROUPS 只用来收窄选择器里看到的文件 */
const FILE_LIMIT = {
  MAX_BYTES: 10 * 1024 * 1024,
  EXTENSIONS: ['xlsx', 'xls', 'csv', 'docx', 'txt', 'md'],
  GROUPS: {
    sheet: ['xlsx', 'xls', 'csv'],
    doc: ['docx', 'txt', 'md'],
  },
};

/** 加号菜单：最多两行八项，数组顺序就是四列网格的展示顺序。 */
const ATTACH_MENU_MAX_ITEMS = 8;
const ATTACH_MENU = [
  { label: '相册', kind: 'image', icon: '/icons/album.svg' },
  { label: 'Excel 表格', kind: 'sheet', icon: '/icons/spreadsheet.svg' },
  { label: 'Word / 文本文档', kind: 'doc', icon: '/icons/file-text.svg' },
];

/** 回收站保留天数（文案用；真值在云函数 purge-recycle-bin 的 RETAIN_DAYS） */
const RECYCLE_RETAIN_DAYS = 30;

/** 会员页展示常量；订单金额与权益仍以云端配置为权威。 */
// 剩余 5 次时提醒一次，避免用户在下一条被拒时才知道免费额度将用尽。
const MEMBERSHIP = Object.freeze({ PRICE: '19.9', POINTS_PER_PERIOD: 10000,
  TRIAL_WARNING_REMAINING: 5, TRIAL_WARNING_SEEN_KEY: 'trialWarningSeenV1',
  CREDIT_DISMISS_KEY: 'credit_notice_dismissed' });

// 统一任务：本地只负责可靠投递，云端维护持续 Agent 会话和执行顺序。
const TASK = {
  PROTOCOL: 2,
  OUTBOX_KEY: 'taskOutboxV2',
  NEW_CONVERSATION_KEY: 'taskNewConversationArmed',
  AGENT_MODE_KEY: 'agentModeV1',
  MODES: { THINK: 'think', RECORD: 'record' },
  // 仅这些错误明确表示云端未接收，可跳过并继续投递下一条；网络未知绝不跳过。
  REJECTED_CODES: ['INVALID_REQUEST_ID', 'INVALID_INPUT', 'EMPTY_INPUT', 'PAYLOAD_TOO_LONG',
    'QUEUE_FULL', 'DAILY_LIMIT_EXCEEDED', 'SUBSCRIPTION_EXPIRED',
    'TRIAL_NOTES_USED', 'TRIAL_EXPIRED', 'POINTS_EXHAUSTED', 'UNAUTHORIZED', 'NO_USER',
    'INVALID_CONFIRMATION', 'UNKNOWN_ACTION'],
  LONG_WAIT: 30000, // 30 秒后解释长等待，避免仅用动画掩盖延迟。
  SUBMIT_TIMEOUT: 15000, // 投递只等持久回执，不等 AI，避免阻塞后续消息。
  TEXT: { queued: '已收到', classifying: '正在处理',
    searching: '正在处理', organizing: '正在处理', executing: '正在处理',
    waiting_confirmation: '这条是旧版待确认操作，请取消后重新发送。', done: '处理完成',
    not_found: '本次检索暂未找到相关记录，可以补充线索再问。',
    failed: '这次没有处理完成，请查看说明后重试。', cancelled: '已取消，本次未继续执行' },
  CONNECTION: '暂时无法确认最新状态，恢复连接后会继续。',
  UNSENT: '已保存在本机，联网后按顺序发送。',
  WAITING: '仍在处理中，可以继续发消息或离开，回来会同步结果。',
};

// 手势阈值用于区分手抖、取消和顶部锁定；录音上限防意外持续占用麦克风。
const VOICE = { SEGMENT_MS: 60000, MAX_MS: 300000, CANCEL_DISTANCE: 64,
  TOP_SAFE_GAP: 16, TOP_TARGET_HEIGHT: 64, STOP_TIMEOUT: 5000 };
// 严格大于 1 秒才展示，避免快速加载时动画闪现；滚动后再聚焦防原生键盘抢跳。
const UX = { ANIMATION_DELAY: 1001, SCROLL_DURATION: 400, SCROLL_FRAME: 16, SCROLL_FOCUS_DELAY: 450,
  REPLY_CARD_LIMIT: 5 }; // 产品要求：回复卡片避免占满聊天，修改优先。

module.exports = { CLOUD_ENV_ID, VOICE, UX, TASK, FN, KB, TIMEOUT, UPLOAD_PREFIX, FILE_LIMIT,
  ATTACH_MENU, ATTACH_MENU_MAX_ITEMS, RECYCLE_RETAIN_DAYS, MEMBERSHIP };
