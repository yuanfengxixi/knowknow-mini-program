const cloud = require('wx-server-sdk');
const parser = require('./parser.js');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function failure(code, message) {
  return { ok: false, code, message };
}

exports.main = async (event) => {
  try {
    const fileID = event && event.fileID;
    const fileName = event && event.fileName;
    if (!parser.isSupportedFileName(fileName)) {
      return failure('UNSUPPORTED_TYPE', '不支持该文件格式');
    }

    let buffer;
    try {
      const downloaded = await cloud.downloadFile({ fileID });
      buffer = downloaded.fileContent;
    } catch (e) {
      console.warn('parse-file download failed:', e.message);
      return failure('DOWNLOAD_FAILED', '文件下载失败');
    }
    return await parser.parseBuffer(buffer, fileName);
  } catch (e) {
    console.error('parse-file crashed:', e);
    return failure('SERVER_ERROR', (e && e.message) ? e.message : String(e));
  }
};
