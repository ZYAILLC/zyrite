import { type KeyboardEvent, useEffect, useState } from 'react';
import { t } from '../i18n';
import type { ThemeFile } from '../lib/backend';
import { commandLabel } from '../lib/commands';
import { deps } from '../lib/document';
import { expandTemplate } from '../lib/images';
import { bindingFromEvent, type CommandId, defaultKeymap, formatBinding } from '../lib/keymap';
import { isMac } from '../lib/platform';
import { DEFAULT_IMAGE_TEMPLATE, DEFAULT_PICGO_URL, effectiveKeymap, type ExportPrefs, type ImagePrefs } from '../lib/prefs';
import { useApp } from '../store';
import { Check, Choice, Row } from './Settings';

/** 设置 › 图片 */
export function ImageSettings() {
  const prefs = useApp((s) => s.image);
  const filePath = useApp((s) => s.filePath);
  const set = (p: Partial<ImagePrefs>) => useApp.setState({ image: { ...prefs, ...p } });
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const example = expandTemplate(prefs.template, filePath, new Date(), 'png');

  return (
    <>
      <h2>{t.setImage}</h2>
      <Row label={t.imageSave}>
        <Choice
          value={prefs.save}
          onChange={(save) => set({ save })}
          options={[
            ['template', t.imageSaveTemplate],
            ['none', t.imageSaveNone],
          ]}
        />
      </Row>
      {prefs.save === 'template' && (
        <Row label={t.imageTemplate} hint={t.imageTemplateHint(example)}>
          <div className="settings-inline">
            <input
              className="settings-input"
              value={prefs.template}
              spellCheck={false}
              onChange={(e) => set({ template: e.target.value })}
              onBlur={(e) => !e.target.value.trim() && set({ template: DEFAULT_IMAGE_TEMPLATE })}
            />
          </div>
        </Row>
      )}
      <Row label={t.imageUpload} hint={t.imageUploadHint}>
        <Choice
          value={prefs.upload}
          onChange={(upload) => set({ upload })}
          options={[
            ['none', t.imageUploadNone],
            ['picgo', 'PicGo / PicList'],
            ['command', t.imageUploadCommand],
          ]}
        />
        {prefs.upload === 'picgo' && (
          <div className="settings-fields">
            <label>
              {t.imagePicgoUrl}
              <input
                className="settings-input"
                value={prefs.picgoUrl}
                spellCheck={false}
                onChange={(e) => set({ picgoUrl: e.target.value })}
                onBlur={(e) => !e.target.value.trim() && set({ picgoUrl: DEFAULT_PICGO_URL })}
              />
            </label>
          </div>
        )}
        {prefs.upload === 'command' && (
          <div className="settings-fields">
            <label>
              {t.imageCommand}
              <input
                className="settings-input"
                value={prefs.command}
                spellCheck={false}
                placeholder="picgo upload"
                onChange={(e) => set({ command: e.target.value })}
              />
            </label>
          </div>
        )}
        {prefs.upload !== 'none' && (
          <div className="settings-inline">
            <button
              type="button"
              className="text-button inline"
              onClick={async () => {
                const path = await deps.backend.pickFile({ name: t.imageFilter, extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] });
                if (!path) return;
                setStatus({ text: t.imageUploading });
                deps.backend
                  .imageUpload(prefs, path)
                  .then((url) => setStatus({ text: url }))
                  .catch((e) => setStatus({ text: String(e instanceof Error ? e.message : e), error: true }));
              }}
            >
              {t.imageTestUpload}
            </button>
            {status && <span className={status.error ? 'status-error' : 'muted'}>{status.text}</span>}
          </div>
        )}
      </Row>
      <Row label={t.imageRemote} hint={t.imageRemoteHint}>
        <Check checked={prefs.remote} label={t.imageRemoteLoad} onChange={(remote) => set({ remote })} />
      </Row>
      <p className="settings-hint">{t.imageKeepFiles}</p>
    </>
  );
}

/** 设置 › 导出 */
export function ExportSettings() {
  const prefs = useApp((s) => s.exportPrefs);
  const filePath = useApp((s) => s.filePath);
  const set = (p: Partial<ExportPrefs>) => useApp.setState({ exportPrefs: { ...prefs, ...p } });
  const run = (kind: 'html' | 'pdf' | 'docx') => {
    useApp.setState({ settingsTab: null });
    void import('../lib/export').then((m) => (kind === 'html' ? m.exportHtml() : kind === 'pdf' ? m.exportPdf() : m.exportDocx()));
  };

  return (
    <>
      <h2>{t.setExport}</h2>
      <p className="muted">{t.exportIntro}</p>
      <Row label={t.exportPaper} hint={t.exportPdfNote}>
        <Choice
          value={prefs.paper}
          onChange={(paper) => set({ paper })}
          options={[
            ['A4', 'A4'],
            ['Letter', 'Letter'],
          ]}
        />
      </Row>
      <Row label={t.exportMargin}>
        <input
          className="settings-range"
          type="range"
          min={5}
          max={40}
          step={1}
          value={prefs.margin}
          onChange={(e) => set({ margin: Number(e.target.value) })}
        />{' '}
        {prefs.margin} mm
      </Row>
      <Row label={t.exportHeader}>
        <Choice
          value={prefs.header}
          onChange={(header) => set({ header })}
          options={[
            ['none', t.exportNone],
            ['title', t.exportHeaderTitle],
          ]}
        />
      </Row>
      <Row label={t.exportFooter} hint={t.exportFooterHint}>
        <Choice
          value={prefs.footer}
          onChange={(footer) => set({ footer })}
          options={[
            ['none', t.exportNone],
            ['date', t.exportFooterDate],
          ]}
        />
      </Row>
      <Row label={t.exportNow}>
        <div className="settings-inline">
          {(['pdf', 'html', 'docx'] as const).map((k) => (
            <button key={k} type="button" className="text-button inline" disabled={!filePath && !useApp.getState().text} onClick={() => run(k)}>
              {k === 'pdf' ? 'PDF' : k === 'html' ? 'HTML' : 'Word'}
            </button>
          ))}
        </div>
      </Row>
    </>
  );
}

/** 设置 › 快捷键：点一下再按新的组合键；Esc 取消，Backspace 去掉 */
export function ShortcutSettings() {
  const overrides = useApp((s) => s.keymap);
  const keymap = effectiveKeymap(overrides);
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const setBinding = (id: CommandId, binding: string) => {
    const next = { ...overrides };
    if (binding === defaultKeymap[id]) delete next[id];
    else next[id] = binding;
    useApp.setState({ keymap: next });
  };

  const onKeyDown = (id: CommandId, e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(null);
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      setBinding(id, '');
      setRecording(null);
      return;
    }
    const b = bindingFromEvent(e.nativeEvent, isMac);
    if (!b) return;
    const clash = (Object.keys(keymap) as CommandId[]).find((other) => other !== id && keymap[other] === b);
    if (clash) {
      setMessage(t.shortcutClash(formatBinding(b, isMac), commandLabel(clash)));
      return;
    }
    setMessage(null);
    setBinding(id, b);
    setRecording(null);
  };

  return (
    <>
      <h2>{t.setShortcuts}</h2>
      <p className="muted">{t.shortcutIntro}</p>
      <div className="shortcut-list">
        {(Object.keys(defaultKeymap) as CommandId[]).map((id) => {
          const b = keymap[id];
          const changed = id in overrides;
          return (
            <div key={id} className="shortcut-row">
              <span className="shortcut-name">{commandLabel(id)}</span>
              <button
                type="button"
                className={`shortcut-key${recording === id ? ' recording' : ''}`}
                data-recording={recording === id ? 'true' : undefined}
                onClick={() => {
                  setMessage(null);
                  setRecording(recording === id ? null : id);
                }}
                onKeyDown={(e) => recording === id && onKeyDown(id, e)}
                onBlur={() => recording === id && setRecording(null)}
              >
                {recording === id ? t.shortcutPress : b ? formatBinding(b, isMac) : t.shortcutNone}
              </button>
              <button
                type="button"
                className="text-button inline"
                style={{ visibility: changed ? 'visible' : 'hidden' }}
                onClick={() => setBinding(id, defaultKeymap[id])}
              >
                {t.shortcutReset}
              </button>
            </div>
          );
        })}
      </div>
      {message && <p className="status-error">{message}</p>}
      {Object.keys(overrides).length > 0 && (
        <button type="button" className="text-button" onClick={() => useApp.setState({ keymap: {} })}>
          {t.shortcutResetAll}
        </button>
      )}
    </>
  );
}

/** 设置 › 主题里的"Typora 主题"：导入 .css（连同旁边的字体文件夹），选用或删除 */
export function ThemeImport() {
  const active = useApp((s) => s.typoraTheme);
  const [list, setList] = useState<ThemeFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void deps.backend.themeList().then(setList, () => setList([]));
  useEffect(refresh, []);

  const importTheme = async () => {
    const path = await deps.backend.pickFile({ name: t.typoraFilter, extensions: ['css'] });
    if (!path) return;
    try {
      const f = await deps.backend.themeImport(path);
      setError(null);
      refresh();
      useApp.setState({ typoraTheme: f.name });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <Row label={t.typoraThemes} hint={t.typoraHint}>
      {list.length > 0 && (
        <div className="settings-choice" role="radiogroup">
          <label>
            <input type="radio" checked={!active} onChange={() => useApp.setState({ typoraTheme: null })} />
            <span>{t.typoraNone}</span>
          </label>
          {list.map((f) => (
            <label key={f.path} className="typora-theme">
              <input type="radio" checked={active === f.name} onChange={() => useApp.setState({ typoraTheme: f.name })} />
              <span>{f.name}</span>
              <button
                type="button"
                className="text-button inline"
                onClick={async (e) => {
                  e.preventDefault();
                  await deps.backend.themeRemove(f.name);
                  if (active === f.name) useApp.setState({ typoraTheme: null });
                  refresh();
                }}
              >
                {t.typoraRemove}
              </button>
            </label>
          ))}
        </div>
      )}
      <div className="settings-inline">
        <button type="button" className="text-button inline" onClick={() => void importTheme()}>
          {t.typoraImport}
        </button>
        {error && <span className="status-error">{error}</span>}
      </div>
      {active && <p className="settings-hint">{t.typoraWysiwygNote}</p>}
    </Row>
  );
}
