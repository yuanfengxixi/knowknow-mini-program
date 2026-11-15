// 云函数调用唯一入口 —— 收编原来散落 6 个页面的 34 处裸 wx.cloud.callFunction。
// 统一：超时、requestId 幂等、超时后按回执恢复（原来只有聊天页有这些保护）。

const { FN } = require('./constants.js');

function newRequestId() {
  return 'req_' + Date.now() + '_' + Math.floor(Math.random() * 1e9);
}

/**
 * 普通云函数调用。返回云函数的 result 对象；网络层错误抛异常。
 * opts.timeout 可覆写；缺省沿用微信默认。
 */
async function call(name, data, opts) {
  opts = opts || {};
  const req = { name: name, data: data || {} };
  const timeout = opts.timeout || 0;
  if (timeout) req.timeout = timeout;
  const res = await wx.cloud.callFunction(req);
  return res.result;
}

/**
 * 上传本地文件到云存储：<前缀><时间戳>-<随机数>.<扩展名>。
 * 路径规则收口成一份（原来 index 两处 + note 一处各拼各的）。返回 fileID。
 */
function resolveUploadExtension(filePath, preferredExtension) {
  const preferred = String(preferredExtension || '').toLowerCase();
  if (/^[a-z0-9]+$/.test(preferred)) return preferred;
  const match = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(String(filePath || ''));
  return match ? match[1].toLowerCase() : 'jpg';
}

async function upload(prefix, filePath, preferredExtension) {
  const ext = resolveUploadExtension(filePath, preferredExtension);
  const cloudPath = prefix + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.' + ext;
  const up = await wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: filePath });
  return up.fileID;
}

/**
 * 导出内容 → 下载 → 转发或保存。
 * 所选笔记的范围必须原样传给云端，由云端按当前身份再次核验。
 */
async function exportAndSave(options) {
  const file = await prepareExport(options);
  return shareLocalFile(file);
}

async function prepareExport(options) {
  const result = await call(FN.EXPORT_DATA, options || { type: 'zip' });
  if (!result || !result.ok) throw new Error(result && result.message || '导出失败，请重试');
  const downloaded = await wx.cloud.downloadFile({ fileID: result.fileID });
  return { filePath: downloaded.tempFilePath, fileName: result.downloadName };
}

function invokeFileApi(name, args) {
  return new Promise((resolve, reject) => wx[name]({ ...args, success: resolve, fail: reject }));
}

async function downloadTaskFile(fileID, fileName) {
  const res = await wx.cloud.downloadFile({ fileID });
  return shareLocalFile({ filePath: res.tempFilePath, ...(fileName ? { fileName } : {}) });
}

async function shareLocalFile(args) {
  if (wx.shareFileMessage) {
    try {
      await invokeFileApi('shareFileMessage', args);
      return true;
    } catch (err) {
      if (/cancel/i.test(err.errMsg || '')) return true;
      if (!wx.saveFileToDisk) throw new Error('文件转发失败，请重试或更新微信');
    }
  }
  if (wx.saveFileToDisk) {
    await invokeFileApi('saveFileToDisk', args);
    return true;
  }
  throw new Error('当前微信不支持文件转发，请更新微信后重试');
}

module.exports = { downloadTaskFile,
  prepareExport, shareLocalFile,
  call, upload, resolveUploadExtension, exportAndSave, newRequestId,
};
