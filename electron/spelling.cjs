// Chromium checks locally. Dictionary downloads contain language data only;
// song text is never sent to a model or a spelling service.
function buildEditingMenu(contents, params) {
  const editable = params.isEditable === true;
  if (!editable && !params.selectionText) return [];
  const template = [], flags = params.editFlags || {};
  const alive = action => () => { if (!contents.isDestroyed()) action(); };
  // Electron 40 can report spellcheckEnabled:false even when Chromium supplies
  // a real misspelling and suggestions. The native misspelling marker already
  // respects the field's spellcheck=false (used by the ABC editor).
  if (editable && params.formControlType !== 'input-password' && params.misspelledWord) {
    const suggestions = [...new Set(params.dictionarySuggestions || [])].filter(word => typeof word === 'string').slice(0, 8);
    for (const suggestion of suggestions) template.push({
      label: suggestion.replace(/&/g, '&&'),
      click: alive(() => contents.replaceMisspelling(suggestion)),
    });
    if (!suggestions.length) template.push({label: 'No spelling suggestions', enabled: false});
    template.push({label: 'Add to dictionary', click: alive(() => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord))});
    template.push({type: 'separator'});
  }
  if (editable) {
    template.push({role: 'undo', enabled: Boolean(flags.canUndo)}, {role: 'redo', enabled: Boolean(flags.canRedo)}, {type: 'separator'});
    template.push({role: 'cut', enabled: Boolean(flags.canCut)});
  }
  template.push({role: 'copy', enabled: Boolean(flags.canCopy)});
  if (editable) template.push({role: 'paste', enabled: Boolean(flags.canPaste)});
  template.push({type: 'separator'}, {role: 'selectAll', enabled: Boolean(flags.canSelectAll)});
  return template;
}

function installSpellingMenu(window, {Menu = require('electron').Menu, platform = process.platform} = {}) {
  const contents = window.webContents, session = contents.session;
  session.setSpellCheckerEnabled(true);
  const supported = session.availableSpellCheckerLanguages || [];
  const languages = ['en-GB', 'en-US'].filter(language => supported.includes(language));
  if (platform !== 'darwin' && languages.length) session.setSpellCheckerLanguages(languages);
  const onContextMenu = (_event, params) => {
    const template = buildEditingMenu(contents, params);
    if (template.length && !window.isDestroyed()) Menu.buildFromTemplate(template).popup({window});
  };
  contents.on('context-menu', onContextMenu);
  return {languages};
}

module.exports = {buildEditingMenu, installSpellingMenu};
