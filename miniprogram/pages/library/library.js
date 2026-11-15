// 仓库（知识库）：嵌套目录树 + 底部输入（跳聊天页处理）+ 长按拖拽移动/删除
const app = getApp();
const cloud = require('../../utils/cloud.js');
const { FN, KB, RECYCLE_RETAIN_DAYS } = require('../../utils/constants.js');
const treeUtil = require('../../utils/tree.js');
const noteSort = require('../../utils/note-sort.js');

Page(Object.assign({}, require('./library-navigation'), require('./library-tree-drag'), require('./library-drag-actions'), require('./library-delete-input'), require('./library-export'), {
  ...require('./library-search'),
  data: {
    searchText: '', searchResults: [], searching: false, searchMore: false, searchError: '',
    tree: [], treeData: [], openPaths: {}, empty: true, loading: true,
    booting: true,   // 知知加载遮罩：首帧渲染完 && 目录树到位才淡出（骨架屏已删，遮罩全程兜底防白屏）
    allExpanded: false,
    selecting: false, selectedNotes: {}, selectedCount: 0, allSelected: false, exporting: false, inlineFocus: false,
    droppedPath: '',   // 刚落入的文件夹路径（播放"接住"脉冲动画）
    inputValue: '', recording: false,
    activeFolder: '/',
    inlineCreate: null,
    showBottomInline: false,
    treeScrollTop: 0,
    treeScrollTarget: '',
    actionDialog: {
      visible: false, mode: '', targetType: '', path: '', noteId: '',
      title: '', description: '', value: '', ops: [], busy: false,
    },
    operationStatus: { visible: false, state: '', text: '' },
    // 拖拽状态
    dragState: {
      active: false,
      type: '',       // 'folder' | 'note'
      path: '',       // 文件夹路径（type=folder 时）
      noteId: '',     // 笔记 ID（type=note 时）
      name: '',       // 显示名
      ghostX: 0,      // 幽灵项 x（px）
      ghostY: 0,      // 幽灵项 y（px）
      startX: 0,      // 长按初始触点 x
      startY: 0,      // 长按初始触点 y
      overTrash: false,
      overRename: false,
      targetFolder: '', // 当前悬停的文件夹路径
    },
  },

  // 拖拽内部状态（不触发渲染）
  _folderRects: [],   // 所有文件夹 DOM rect 快照
  _trashRect: null,   // 垃圾桶 DOM rect 快照
  _renameRect: null,  // 重命名图标 DOM rect 快照
  _treeViewportRect: null,
  _dragMoved: false,  // 是否真的移动过（区分点击和拖拽）


}));
