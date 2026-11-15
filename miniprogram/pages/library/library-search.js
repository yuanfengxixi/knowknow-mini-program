const cloud = require('../../utils/cloud');
const { FN } = require('../../utils/constants');
module.exports = {
  openSearchNote(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/note/note?id=' + encodeURIComponent(id) });
  },
  selectSearchNote(e) { this.toggleNoteSelection(e.currentTarget.dataset.id); },
  onSearchInput(e) {
    clearTimeout(this._searchTimer);
    this._searchRevision = (this._searchRevision || 0) + 1;
    const searchText = e.detail.value;
    this.setData({ searchText, searchResults: [], searchMore:false, searchError:'', searching:!!searchText.trim(), selectedNotes:{}, selectedCount:0, allSelected:false });
    if (searchText.trim()) this._searchTimer = setTimeout(() => this.searchNotes(false), 250);
  },
  clearSearch() { this.onSearchInput({detail:{value:''}}); },
  searchMoreNotes() { if (!this.data.searching) return this.searchNotes(true); },
  retrySearch() { return this.searchNotes(false); },
  async searchNotes(more) {
    const text = (this.data.searchText || '').trim();
    if (!text) return;
    const revision = this._searchRevision;
    const existing = more ? this.data.searchResults : [];
    this.setData({ searching:true, searchError:'' });
    try {
      const result = await cloud.call(FN.LIST_NOTES, {search:text, offset:existing.length});
      if (revision !== this._searchRevision) return;
      if (!result || !result.ok) throw new Error(result && result.message || '搜索失败，请重试');
      this.setData({ searchResults:existing.concat(result.notes), searchMore:result.hasMore, allSelected:false });
    } catch (e) {
      if (revision === this._searchRevision) this.setData({searchError:e.message || '搜索失败，请重试'});
    } finally {
      if (revision === this._searchRevision) this.setData({searching:false});
    }
  },
};
