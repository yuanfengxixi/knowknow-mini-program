// 工具只描述云端知识库操作；不约定对话类型、回复格式或口吻。
const string = { type: 'string' }, strings = { type: 'array', items: string };
const integer = { type: 'integer', minimum: 0 };
const definition = (name, description, properties, required = []) => ({ type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const definitions = [
  definition('list_notes', '列出知识库笔记标题、目录、修改时间。可分页、按目录或回收站筛选。',
    { folder: string, deleted: { type: 'boolean' }, offset: integer, limit: integer }),
  definition('read_note', '读取一篇或多篇笔记的指定正文范围及附件。批量读取时每篇独立鉴权并返回结果。',
    { noteId: string, offset: integer, limit: integer, reads: { type: 'array', maxItems: 20, items: {
      type: 'object', properties: { noteId: string, offset: integer, limit: integer }, required: ['noteId'], additionalProperties: false,
    } } }),
  definition('search_notes', '按关键词和可用语义索引搜索笔记，返回正文片段；需要全文可调用 read_note。',
    { query: string, folder: string, offset: integer, limit: integer }, ['query']),
  definition('write_note', '创建笔记，自动创建所需目录；当前消息的附件默认随笔记保存，可关闭 includeAttachments。',
    { title: string, content: string, folder: string, tags: strings, includeAttachments: { type: 'boolean' } }, ['title', 'content', 'folder']),
  definition('edit_note', '精确替换现有笔记中的一段正文。oldSnippet 必须唯一匹配；可用空 newSnippet 删除该段。',
    { noteId: string, oldSnippet: string, newSnippet: string }, ['noteId', 'oldSnippet', 'newSnippet']),
  definition('update_memory', '批量新增、修改或移除“AI 了解的我”记忆卡片。只保存未来仍有用的稳定背景、偏好和持续状态；卡片内不得写入记录日期、用户确认时间、来源、版本或说明性占位内容；修改或移除必须传入快照中的版本。', {
    actions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: {
      action: { type: 'string', enum: ['add', 'update', 'remove'] }, cardId: string,
      version: { type: 'integer', minimum: 1 }, content: string,
    }, required: ['action'], additionalProperties: false } },
  }, ['actions']),
  definition('manage_notes', '移动、重命名、软删除或恢复笔记和目录；删除内容进入回收站。', {
    operations: { type: 'array', items: { type: 'object', properties: {
      action: { type: 'string', enum: ['batchDelete', 'restoreNote', 'moveNote', 'batchMove', 'renameNote',
        'createFolder', 'deleteFolder', 'restoreFolder', 'moveFolder', 'renameFolder', 'reorder'] },
      noteId: string, noteIds: strings, title: string, toFolder: string, path: string, from: string, to: string, paths: strings,
    }, required: ['action'], additionalProperties: false } },
  }, ['operations']),
  definition('export_notes', '导出单条笔记为 Markdown 文件，或整个知识库为 ZIP 压缩包。',
    { type: { type: 'string', enum: ['md', 'zip'] }, noteId: string }, ['type']),
];
// 分页限制防止一次工具输出耗尽会话上下文；可使用 offset 遍历，不限制回答长度。
const LIMITS = { PAGE: 50, READ: 16000, CORPUS: 10000, SNIPPET: 1000, EMBED: 8000, EMBED_TIMEOUT: 15000 };
const EMBEDDING = { MODEL: 'BAAI/bge-m3', BASE_URL: 'https://api.siliconflow.cn/v1' };
module.exports = { definitions, LIMITS, EMBEDDING };
