const { UX } = require('./constants');
function selectCards(notes) {
  const rank = n => n.merged ? 0 : n.isNew ? 1 : 2;
  const sorted = (notes || []).filter(n => n && n._id).slice().sort((a, b) => rank(a) - rank(b));
  const seen = new Set();
  return sorted.filter(n => {
    if (seen.has(n._id)) return false;
    seen.add(n._id);
    return true;
  }).slice(0, UX.REPLY_CARD_LIMIT);
}
function fromResult(result) {
  return selectCards([
    ...(result.editedNotes || []).map(n => ({ ...n, merged: true, isNew: false })),
    ...(result.notes || []).map(n => ({ ...n, isNew: true })),
    ...(result.matches || []),
    ...(result.note ? [result.note] : []),
  ]);
}
module.exports = { selectCards, fromResult };
