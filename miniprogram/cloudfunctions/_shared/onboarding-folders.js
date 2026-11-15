const MAX_CUSTOM_FOLDERS = 30;
const MAX_FOLDER_NAME_LENGTH = 40;

function normalizeCustomFolders(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_CUSTOM_FOLDERS) {
    throw new Error(`笔记目录需包含 1-${MAX_CUSTOM_FOLDERS} 个文件夹`);
  }
  const folders = input.map((value) => {
    const path = String(value || '').trim();
    const parts = path.split('/').filter(Boolean);
    // 限制层级和控制字符，防止用户输入被解释为意外目录结构。
    if (!path.startsWith('/') || parts.length < 1 || parts.length > 2 ||
        parts.some((part) => !part.trim() || part.trim().length > MAX_FOLDER_NAME_LENGTH ||
          /[\\\x00-\x1f]/.test(part) || part === '.' || part === '..') ||
        path !== '/' + parts.join('/')) {
      throw new Error('文件夹格式不正确，请返回调整后重试');
    }
    return '/' + parts.map((part) => part.trim()).join('/');
  });
  if (!folders.includes('/个人')) folders.unshift('/个人');
  if (new Set(folders).size !== folders.length) throw new Error('文件夹名称不能重复');
  return folders;
}

module.exports = { normalizeCustomFolders };
