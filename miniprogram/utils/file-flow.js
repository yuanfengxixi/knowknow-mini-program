// 聊天页文档流程：纯函数保持可离线测试，页面相关能力收口在 create(page) 中。
const cloud = require('./cloud.js');
const taskRouting = require('./task-routing');
const { FN, UPLOAD_PREFIX, FILE_LIMIT, TASK } = require('./constants.js');

const FILE_PICKER_GUIDE_KEY = 'filePickerGuideShown';
const FILE_PICKER_GUIDE = '微信只能从聊天里选文件。可以先把文件发给『文件传输助手』，再回来选';

function getFileExtension(fileName) {
  const match = /\.([^.]+)$/.exec(String(fileName || ''));
  return match ? match[1].toLowerCase() : '';
}

function validateFile(file) {
  const extension = getFileExtension(file && file.name);
  if (Number(file && file.size) > FILE_LIMIT.MAX_BYTES) {
    return { ok: false, code: 'FILE_TOO_LARGE', message: '文件超过 10MB，换个小点的' };
  }
  if (FILE_LIMIT.EXTENSIONS.indexOf(extension) < 0) {
    return { ok: false, code: 'UNSUPPORTED_TYPE', message: '目前支持 Excel、Word、txt、md 文件' };
  }
  return { ok: true, extension: extension };
}

function formatFileSize(size) {
  const bytes = Math.max(0, Number(size) || 0);
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Number((bytes / 1024).toFixed(1)) + ' KB';
  return Number((bytes / (1024 * 1024)).toFixed(1)) + ' MB';
}

function parseErrorText(code) {
  if (code === 'UNSUPPORTED_TYPE') return '这个格式我还读不了，目前支持 Excel、Word、txt、md';
  if (code === 'FILE_TOO_LARGE') return '文件太大了';
  return '文件没读成功，重传一次试试';
}

function create(page) {
  let currentFile = null;

  function showPickerGuide(force) {
    let shown = false;
    try { shown = !!wx.getStorageSync(FILE_PICKER_GUIDE_KEY); } catch (e) {}
    if (!force && shown) return false;
    page._quoteRef = null;
    page.pushMsg('ai', FILE_PICKER_GUIDE, { excludeFromHistory: true });
    try { wx.setStorageSync(FILE_PICKER_GUIDE_KEY, true); } catch (e) {}
    return true;
  }

  function clearCurrentFile() {
    currentFile = null;
    page.setData({ pendingFile: null });
  }

  function fileMessage(file) {
    return { name: file.name, sizeText: file.sizeText };
  }

  function attachmentOptions(file) {
    return {
      fileText: file.text,
      fileMeta: Object.assign({}, file.meta || {}, { truncated: !!file.truncated }),
      fileFileID: file.fileID,
    };
  }

  function send(text) {
    if (!currentFile) return false;
    const file = currentFile;
    const instruction = String(text || '').trim() || '请看一下这份文件';
    const quoteText = instruction.length > 80 ? instruction.slice(0, 80) + '…' : instruction;
    page._quoteRef = { name: '我', text: quoteText };
    const id = taskRouting.handle(page, instruction, null, false,
      Object.assign(attachmentOptions(file), { inputType: 'file', file: fileMessage(file), agentMode: page.data.agentMode,
        newConversation: page.data.newConversationArmed }));
    if (id) {
      wx.setStorageSync(TASK.NEW_CONVERSATION_KEY,false);
      clearCurrentFile(); page.setData({ inputValue: '', inputFocused: false, newConversationArmed: false });
    }
    return true;
  }

  async function handleChosenFile(file) {
    const validation = validateFile(file);
    if (!validation.ok) {
      wx.showToast({ title: validation.message, icon: 'none' });
      return;
    }
    const tempFilePath = file.path || file.tempFilePath;
    if (!tempFilePath) {
      wx.showToast({ title: '文件没选成功，重试一次', icon: 'none' });
      return;
    }

    page.setData({ uploading: true });
    page.setData({ busyText: '读取中…' });
    let fileID = '';
    try {
      fileID = await cloud.upload(UPLOAD_PREFIX.NOTE_FILES, tempFilePath, validation.extension);
      const parsed = await cloud.call(FN.PARSE_FILE, { fileID: fileID, fileName: file.name });
      if (!parsed || !parsed.ok) {
        console.warn('parse uploaded file failed', fileID, parsed && parsed.code);
        page.setData({ pendingFile: null });
        page.setData({ busyText: '' });
        wx.showToast({ title: parseErrorText(parsed && parsed.code), icon: 'none' });
        return;
      }

      currentFile = Object.assign({}, parsed, {
        fileID: fileID,
        name: file.name,
        size: Number(file.size) || 0,
        ext: validation.extension,
        sizeText: formatFileSize(file.size),
      });
      page.setData({
        pendingFile: {
          fileID: fileID,
          name: currentFile.name,
          size: currentFile.size,
          sizeText: currentFile.sizeText,
          ext: currentFile.ext,
        },
      });
    } catch (e) {
      if (fileID) console.warn('parse uploaded file failed', fileID, e);
      else console.error('upload file failed', e);
      currentFile = null;
      page.setData({ pendingFile: null });
      page.setData({ busyText: '' });
      wx.showToast({ title: fileID ? '文件没读成功，重传一次试试' : '文件上传失败', icon: 'none' });
    } finally {
      page.setData({ uploading: false });
      page.setData({ busyText: '' });
    }
  }

  // group 来自加号菜单（sheet / doc），只收窄选择器里看到的文件；
  // 校验仍走 EXTENSIONS 全集，所以分组选错了也不会把合法文件误判成不支持。
  function pickFile(group) {
    if (page.data.uploading || page.data.pendingImage || currentFile) return;
    const guideShownNow = showPickerGuide(false);
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: FILE_LIMIT.GROUPS[group] || FILE_LIMIT.EXTENSIONS,
      success: function (res) {
        const file = res && res.tempFiles && res.tempFiles[0];
        if (!file) {
          if (!guideShownNow) showPickerGuide(true);
          return;
        }
        handleChosenFile(file);
      },
      fail: function (err) {
        if (err && err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '选文件失败', icon: 'none' });
        }
      },
    });
  }

  return { pickFile, removePendingFile: clearCurrentFile, send };

}

module.exports = {
  getFileExtension,
  validateFile,
  formatFileSize,
  parseErrorText,
  create,
};
