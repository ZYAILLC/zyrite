import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect } from 'react';
import { AiRewrite } from './components/AiPanels';
import { AnnotationMargin, SelectionMenu } from './components/Annotations';
import { Editor } from './components/Editor';
import { MergeBar, MergeView, ReviewBar, ReviewView } from './components/Review';
import { FileTree } from './components/FileTree';
import { FindBar } from './components/FindBar';
import { Outline } from './components/Outline';
import { Preview } from './components/Preview';
import { Settings } from './components/Settings';
import { FilesHead } from './components/FilesHead';
import { Palette } from './components/Palette';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';
import { useShortcuts } from './components/useShortcuts';
import { useTheme } from './components/useTheme';
import { locale, t } from './i18n';
import { dropFiles, newDoc, openDialog, openFolder, openPath, prepareClose, restoreSession, startRecovery } from './lib/document';
import { backend } from './lib/backend';
import { basename, dirname } from './lib/paths';
import { loadAnnotations } from './lib/annotations';
import { loadNoteNames, openIndex } from './lib/linkIndex';
import { refreshReview } from './lib/review';
import { loadAccess } from './lib/access';
import { AccessPrompt } from './components/AccessPrompt';
import { handleFsChanges, refreshTree, revealInTree, updateWatch } from './lib/vault';
import { isMac, isTauri } from './lib/platform';
import { useApp, useBinding } from './store';

/** 启动时只还原一次（开发模式下 StrictMode 会把 effect 跑两遍） */
let restored = false;

export function App() {
  useTheme();
  useShortcuts();
  const edition = useApp((s) => s.edition);
  const typoraTheme = useApp((s) => s.typoraTheme);
  const openFolderKey = useBinding('folder.open');
  const openFileKey = useBinding('file.open');
  const newFileKey = useBinding('file.new');
  const filePath = useApp((s) => s.filePath);
  const dirty = useApp((s) => s.dirty);
  const folder = useApp((s) => s.folder);
  const savedText = useApp((s) => s.savedText);
  const review = useApp((s) => s.review);
  const merge = useApp((s) => s.merge);
  const annotationVersion = useApp((s) => s.annotationVersion);
  const showSource = useApp((s) => s.showSource);
  const showPreview = useApp((s) => s.showPreview);
  const sidebarPage = useApp((s) => s.sidebarPage);
  // 审阅、合并时只显示原文这一栏（里面换成审阅 / 合并视图）
  const split = showSource && showPreview && !review && !merge;
  const full = edition === 'full';
  const fileName = filePath ? basename(filePath) : t.untitled;
  const dir = filePath ? basename(dirname(filePath)) || undefined : undefined;

  useEffect(() => {
    if (!restored) {
      restored = true;
      void restoreSession();
    }
    const stop = startRecovery();
    if (!isTauri) return stop;
    // 关窗前处理未保存的修改；监听存在时窗口不会自己关，取消就不调用 destroy
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await prepareClose())) event.preventDefault();
    });
    // 系统拖进来的文件走 Tauri 的事件（网页的 drop 事件拿不到路径）；坐标是物理像素
    const unlistenDrop = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return;
      const ratio = window.devicePixelRatio || 1;
      const { x, y } = event.payload.position;
      void dropFiles(event.payload.paths, { x: x / ratio, y: y / ratio });
    });
    return () => {
      stop();
      void unlisten.then((f) => f());
      void unlistenDrop.then((f) => f());
    };
  }, []);

  // 库：换文件夹时刷新文件树；换文件夹或文件时更新监听范围；当前文件的上级文件夹自动展开
  useEffect(() => {
    void refreshTree();
    void openIndex().then(loadAccess);
  }, [folder]);
  useEffect(() => {
    void updateWatch();
    if (filePath) revealInTree(filePath);
  }, [folder, filePath]);
  useEffect(() => {
    const off = backend.onFsChanged(handleFsChanges);
    const offIndex = backend.onIndexChanged(() => void loadNoteNames());
    // .zyrite 里 Agent 协作的数据变了（MCP 写入队列、回复批注、活动记录）
    const offData = backend.onDataChanged((kinds) => {
      const s = useApp.getState();
      if (kinds.includes('queue') || kinds.includes('config')) void refreshReview();
      if (kinds.includes('annotations')) useApp.setState({ annotationVersion: s.annotationVersion + 1 });
      if (kinds.includes('agents') || kinds.includes('activity')) useApp.setState({ agentVersion: s.agentVersion + 1 });
      if (kinds.includes('grants') || kinds.includes('requests')) void loadAccess();
    });
    void backend.menuLocalize(`${t.settings}…`);
    // 旧版后端没有这个命令：失败就算了，不影响启动
    backend.setLocale(locale).catch(() => {});
    const offSettings = backend.onOpenSettings(() => {
      // 已经开着就留在当前分类
      if (!useApp.getState().settingsTab) useApp.setState({ settingsTab: 'general' });
    });
    // 已经开着时在 Finder 里双击 .md
    const offOpen = backend.onOpenPath((path) => {
      if (path !== useApp.getState().filePath) void openPath(path);
    });
    return () => {
      void offOpen.then((f) => f());
      void offSettings.then((f) => f());
      void off.then((f) => f());
      void offIndex.then((f) => f());
      void offData.then((f) => f());
    };
  }, []);

  // 审阅：打开、保存、外部修改后重新比较
  useEffect(() => {
    void refreshReview();
  }, [filePath, savedText, dirty, folder]);
  // 批注
  useEffect(() => {
    void loadAnnotations();
    useApp.setState({ composer: null });
  }, [filePath, folder, annotationVersion]);

  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${fileName} — Zyrite`;
    if (isTauri) getCurrentWindow().setTitle(document.title).catch(() => {});
  }, [fileName, dirty]);

  // 版本切换只是 UI 开关：主区域始终挂在同一位置，切换时不重建编辑器，光标和滚动位置都保留
  return (
    <div className="app" data-edition={edition} data-platform={isMac ? 'mac' : 'other'}>
      <TitleBar dir={dir} fileName={fileName} dirty={dirty} />
      <div className="workspace">
        {full && (
          <aside className="sidebar sidebar-left">
            <div className="sidebar-tabs edition-switch" role="tablist">
              {(['files', 'doc'] as const).map((page) => (
                <button
                  key={page}
                  type="button"
                  role="tab"
                  aria-selected={sidebarPage === page}
                  aria-pressed={sidebarPage === page}
                  onClick={() => useApp.setState({ sidebarPage: page })}
                >
                  {page === 'files' ? t.sidebarFiles : t.sidebarDoc}
                </button>
              ))}
            </div>
            {/* 两页都一直挂着，切页时文件树的展开、滚动位置不丢 */}
            <div className="sidebar-page sidebar-files" role="tabpanel" aria-label={t.vault} hidden={sidebarPage !== 'files'}>
              <FilesHead />
              {folder ? (
                <FileTree />
              ) : (
                <div className="files-empty">
                  <button type="button" className="text-button" onClick={() => void openFolder()}>
                    {t.cmdOpenFolder} <span className="muted">{openFolderKey}</span>
                  </button>
                  <button type="button" className="text-button" onClick={() => void openDialog()}>
                    {t.cmdOpenFile} <span className="muted">{openFileKey}</span>
                  </button>
                  <button type="button" className="text-button" onClick={() => void newDoc()}>
                    {t.cmdNewFile} <span className="muted">{newFileKey}</span>
                  </button>
                </div>
              )}
            </div>
            <div className="sidebar-page sidebar-outline" role="tabpanel" aria-label={t.sidebarDoc} hidden={sidebarPage !== 'doc'}>
              <Outline />
            </div>
          </aside>
        )}
        {/* 编辑器的正文根元素是 #write，沿用 Typora 的约定，方便兼容 Typora 主题 */}
        <main className="main" aria-label={t.editor}>
          <FindBar />
          <ReviewBar />
          <MergeBar />
          <div className={`panes${split ? ' split' : ''}`}>
            {/* 编辑器这一栏始终挂在同一位置：开关预览只换编辑器种类，滚动容器不重建 */}
            <section className="pane">
              {split && <PaneHead label={t.paneSource} onClose={() => useApp.getState().toggleSource()} />}
              <div className={`editor-scroll${typoraTheme ? ' zy-typora' : ''}`}>
                {/* 审阅、合并时暂时换下编辑器（内容都在 store 里，回来时重建） */}
                {review ? <ReviewView /> : merge ? <MergeView /> : <Editor />}
                {!review && !merge && <AnnotationMargin />}
              </div>
            </section>
            {split && (
              <section className="pane pane-preview">
                <PaneHead label={t.panePreview} onClose={() => useApp.getState().togglePreview()} />
                <Preview />
              </section>
            )}
          </div>
        </main>
      </div>
      <StatusBar />
      <Palette />
      <SelectionMenu />
      <AiRewrite />
      <Settings />
      <AccessPrompt />
    </div>
  );
}

/** 分栏时每栏顶上一行：栏名和关闭按钮（细线分隔） */
function PaneHead({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <div className="pane-head">
      <span>{label}</span>
      <button
        type="button"
        className="icon-button"
        title={t.closePane(label)}
        aria-label={t.closePane(label)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 5l14 14M19 5L5 19" />
        </svg>
      </button>
    </div>
  );
}
