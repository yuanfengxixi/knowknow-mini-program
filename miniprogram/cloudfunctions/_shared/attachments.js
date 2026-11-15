const DELETE_BATCH_SIZE = 50;

function collectFileIds(notes) {
  const fileIds = [];
  for (const note of notes) {
    if (note.audioFileId) fileIds.push(note.audioFileId);
    if (Array.isArray(note.images)) fileIds.push(...note.images.filter(Boolean));
    if (Array.isArray(note.files)) fileIds.push(...note.files.filter(Boolean));
  }
  return Array.from(new Set(fileIds));
}

function chunkFileIds(fileIds) {
  const chunks = [];
  // 防止超过 cloud.deleteFile 单次 fileList 条数上限导致整批附件无法删除。
  for (let index = 0; index < fileIds.length; index += DELETE_BATCH_SIZE) {
    chunks.push(fileIds.slice(index, index + DELETE_BATCH_SIZE));
  }
  return chunks;
}

function countDeletedFiles(result) {
  if (!result || !Array.isArray(result.fileList)) return 0;
  return result.fileList.filter((file) => file && file.status === 0).length;
}

module.exports = {
  collectFileIds,
  chunkFileIds,
  countDeletedFiles,
  DELETE_BATCH_SIZE,
};
