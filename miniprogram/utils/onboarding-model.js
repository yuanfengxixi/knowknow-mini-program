const questions = require('./onboarding-questions');
const types = require('./onboarding-types');
const MAX_CUSTOM_FOLDERS = 30;
const MAX_FOLDER_NAME_LENGTH = 40;

const cards = [
  { num: '01', title: '想到什么，随手记下', desc: '一个想法、一段复盘、一个计划，\n不用整理，先记录下来。', art: '/images/onboarding/01.jpg', foot: '支持文字和语音记录', icon: 'mic' },
  { num: '02', title: '不用分类，AI 来帮你', desc: '说清你想记录的内容，\nAI 帮你理解、整理，放进合适的文件夹。', art: '/images/onboarding/02.jpg', foot: '记录时无需考虑「应该放在哪里」', icon: 'idea' },
  { num: '03', title: '你的内容，各归其位', desc: '你的记录会进入对应的文件夹，\n慢慢形成属于自己的知识结构。', art: '/images/onboarding/03.jpg', foot: '文件夹也可以随时调整', icon: 'folder' },
  { num: '04', title: '记下的，都能找回来', desc: '不管是很久以前的一个想法，\n还是某次复盘里的一个结论，\n都可以随时搜索。', art: '/images/onboarding/04.jpg', foot: '让过去的记录真正产生价值', icon: 'search' },
  { num: '05', title: '让零散记录，\n慢慢成为你的资产', desc: '今天记录一个想法，明天留下一次复盘。\n长期积累下来，\n它们会变成真正属于你的知识。', art: '/images/onboarding/05.jpg', foot: '', icon: '' },
];

function recommend(answers) {
  if (answers.length !== questions.length || questions.some((q, i) => !q.a[answers[i]])) {
    throw new Error('请先完成所有问题');
  }
  const scores = { structure: 0, collect: 0, focus: 0, explore: 0, connect: 0, free: 0 };
  answers.forEach((answer, i) => { scores[questions[i].a[answer][2]]++; });
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [[top, value], [second]] = ranked;
  // 原 HTML 的园丁分支不可达；六项近乎均衡时采用长期积累模板。
  if (value - ranked[ranked.length - 1][1] <= 1) return 'gardener';
  const pair = [top, second].sort().join(',');
  const combos = { 'connect,explore': 'fox', 'collect,structure': 'squirrel',
    'collect,focus': 'bee', 'explore,free': 'firefly', 'free,structure': 'cat' };
  if (combos[pair]) return combos[pair];
  const dominant = { structure: 'beaver', focus: 'falcon', explore: 'octopus',
    collect: 'squirrel', connect: 'fox', free: 'cat' };
  return dominant[top];
}

const cleanLabel = text => text.replace(/^[^\u4e00-\u9fffA-Za-z0-9]+/u, '').trim();

function createDraft(type) {
  return types[type].folders.map((folder, i) => ({
    id: 'root-' + i,
    name: cleanLabel(folder[0]),
    children: folder[1].map((name, j) => ({ id: 'child-' + i + '-' + j, name })),
  }));
}

function folderPaths(draft) {
  if (!draft.length) throw new Error('请至少保留一个文件夹');
  const folderCount = draft.reduce((count, root) => count + 1 + root.children.length, 0);
  if (folderCount > MAX_CUSTOM_FOLDERS) throw new Error(`文件夹最多 ${MAX_CUSTOM_FOLDERS} 个`);
  const paths = [];
  function nameOf(value) {
    const name = String(value || '').trim();
    // 文件夹名中的斜杠会意外改变层级，控制字符会造成不可见的重复目录。
    if (!name || name.length > MAX_FOLDER_NAME_LENGTH || /[/\\\x00-\x1f]/.test(name) || name === '.' || name === '..') {
      throw new Error('请填写 1-40 字的文件夹名称，名称中不能包含斜杠');
    }
    return name;
  }
  draft.forEach((root) => {
    const path = '/' + nameOf(root.name);
    paths.push(path);
    root.children.forEach((child) => paths.push(path + '/' + nameOf(child.name)));
  });
  if (new Set(paths).size !== paths.length) throw new Error('同一层的文件夹名称不能重复');
  return paths;
}

module.exports = { questions, types, cards, recommend, createDraft, folderPaths };
