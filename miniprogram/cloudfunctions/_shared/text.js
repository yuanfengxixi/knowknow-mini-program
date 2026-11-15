// AI 输出 → 可渲染的轻量 markdown 子集（D-2026-08-23-笔记markdown排版）：
// 保留 ## 标题、- 列表、1. 有序列表、**加粗**（前端 utils/markdown.js parseBlocks 会渲染），
// 清掉渲染器不认、编辑态会露符号的：代码围栏、行内代码、斜体、删除线、> 引用、分隔线；* / + 列表统一成 - 。
// 存量【标题】/• /「重点」纯文本格式原样穿透，parseBlocks 原生兼容，不做迁移。
function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    // 消息时间锚点只属于对话上下文，绝不能随模型输出进入聊天正文或笔记。
    .replace(/^\s*\[消息发生时间：[^\]\n]+\]\s*$/gm, '')
    .replace(/^\s*```.*$/gm, '')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    // 内部笔记链接不能作为 Markdown 原码进入回复或笔记；仅识别 note: 协议，保留普通网址和业务编号。
    .replace(/\[([^\]\n]+)\]\([ \t]*note:[A-Za-z0-9_-]+[ \t]*\)/gi, '$1')
    .replace(/[（(<][ \t]*note:[A-Za-z0-9_-]+[ \t]*[）)>]/gi, '')
    // 排除网址路径和查询参数中的 note:，防止清理正常外部链接；中文紧邻的内部引用仍需去除。
    .replace(/(^|[^\w/:?=&.%#-])note:[A-Za-z0-9_-]+/gi, '$1')
    // 单星斜体剥标记；守卫式写法防止吃掉 **加粗** 的星号（同 utils/markdown.js stripInlineMarks）
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[*+]\s+/gm, '- ')
    .replace(/^\s*(?:---+|\*\*\*+|___+)\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { normalizeText };
