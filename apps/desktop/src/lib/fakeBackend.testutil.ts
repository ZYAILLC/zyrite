// 测试用：内存里的后端（文件系统、对话框、会话），以及重置 store
import { defaultSettings, useApp } from '../store';
import {
  type Activity,
  type AgentInfo,
  type McpAccess,
  type AiEvent,
  type AiPassage,
  type Annotation,
  type Backend,
  type ConflictChoice,
  FileError,
  type QueueItem,
  type Session,
  type Stamp,
  type UnsavedChoice,
  type VaultConfig,
  type WatchSpec,
} from './backend';
import { activeEditor } from './editorRef';

/** 内存里的文件系统 + 记录对话框调用 */
export function fakeBackend() {
  let clock = 1;
  const files = new Map<string, { text: string; stamp: Stamp }>();
  const aiListeners = new Set<(e: AiEvent) => void>();
  const dirs = new Set<string>();
  const state = {
    files,
    session: null as Session | null,
    launch: null as string | null,
    unsavedAnswer: 'cancel' as UnsavedChoice,
    conflictAnswer: 'cancel' as ConflictChoice,
    savePick: null as string | null,
    folderPick: null as string | null,
    asked: [] as string[],
    errors: [] as string[],
    opened: [] as string[],
    allowed: [] as string[],
    trashAnswer: true,
    indexRoot: null as string | null,
    linkCounts: {} as Record<string, number>,
    linkUpdated: {} as Record<string, string[]>,
    updateLinksAnswer: 'update' as 'update' | 'skip' | 'cancel',
    renames: [] as { from: string; to: string; updateLinks: boolean }[],
    baselines: new Map<string, string>(),
    queue: new Map<string, QueueItem>(),
    annotations: new Map<string, Annotation[]>(),
    agents: [] as AgentInfo[],
    access: { grants: [], requests: [] } as McpAccess,
    activity: [] as Activity[],
    config: { review: { enabled: true }, mcp: { read: true, write: true, directWrite: false } } as VaultConfig,
    keys: new Map<string, string>(),
    aiAnswer: '好的。',
    aiRequests: [] as { role: string; content: string }[][],
    /** 写入的二进制文件（base64） */
    binaries: new Map<string, string>(),
    uploads: [] as string[],
    uploadUrl: 'https://img.example/x.png',
    exported: new Map<string, unknown>(),
    printed: 0,
    clipboardImage: null as string | null,
    themes: new Map<string, string>(),
    passages: [] as AiPassage[],
    watched: [] as WatchSpec[][],
  };
  const write = (path: string, text: string) => {
    const stamp = { modifiedMs: clock++, len: text.length };
    files.set(path, { text, stamp });
    return stamp;
  };
  const b: Backend = {
    pickOpen: async () => null,
    pickSave: async () => state.savePick,
    pickFolder: async () => state.folderPick,
    listMarkdown: async (root) =>
      [...files.keys()].filter((p) => p.startsWith(`${root}/`)).map((p) => p.slice(root.length + 1)),
    async openFile(path) {
      const f = files.get(path);
      if (!f) throw new FileError('notFound', path);
      return { path, ...f };
    },
    async saveFile(path, text, expected) {
      const cur = files.get(path);
      if (expected && cur && cur.stamp.modifiedMs !== expected.modifiedMs) {
        throw new FileError('conflict', path, cur.stamp);
      }
      return write(path, text);
    },
    loadSession: async () => state.session,
    async saveSession(s) {
      state.session = { ...s, updatedMs: 0 };
    },
    launchPath: async () => state.launch,
    async askUnsaved(name) {
      state.asked.push(`unsaved:${name}`);
      return state.unsavedAnswer;
    },
    async askConflict(name) {
      state.asked.push(`conflict:${name}`);
      return state.conflictAnswer;
    },
    async showError(text) {
      state.errors.push(text);
    },
    async openExternal(url) {
      state.opened.push(url);
    },
    resolveImage: (src) => src,
    fileUrl: (path) => `asset://${path}`,
    pickFile: async () => state.savePick,
    pickExport: async () => state.savePick,
    clipboardImage: async () => state.clipboardImage,
    async imageWrite(path, base64) {
      let target = path;
      for (let i = 1; state.binaries.has(target) || files.has(target); i++) target = path.replace(/(\.[^./]+)?$/, `-${i}$1`);
      state.binaries.set(target, base64);
      return target;
    },
    async imageCopy(from, to) {
      return this.imageWrite(to, state.binaries.get(from) ?? '');
    },
    async imageUpload(_prefs, path) {
      state.uploads.push(path);
      return state.uploadUrl;
    },
    async readBase64(path) {
      const v = state.binaries.get(path);
      if (v === undefined) throw new FileError('notFound', path);
      return v;
    },
    async writeText(path, text) {
      state.exported.set(path, text);
    },
    async exportDocx(path, doc) {
      state.exported.set(path, doc);
    },
    async printWindow() {
      state.printed++;
    },
    async themeList() {
      return [...state.themes.keys()].map((path) => ({ name: path.replace(/^.*\//, '').replace(/\.css$/, ''), path }));
    },
    async themeImport(path) {
      state.themes.set(path, files.get(path)?.text ?? '');
      return { name: path.replace(/^.*\//, '').replace(/\.css$/, ''), path };
    },
    async themeRemove(name) {
      for (const p of state.themes.keys()) if (p.endsWith(`/${name}.css`)) state.themes.delete(p);
    },
    async themeRead(path) {
      return state.themes.get(path) ?? files.get(path)?.text ?? '';
    },
    async allowAssetDirs(paths) {
      state.allowed.push(...paths);
    },
    async isDir(path) {
      return dirs.has(path) || [...files.keys()].some((p) => p.startsWith(`${path}/`));
    },
    async listTree(root) {
      const out = new Map<string, boolean>();
      for (const p of [...files.keys(), ...dirs]) {
        if (!p.startsWith(`${root}/`)) continue;
        const parts = p.slice(root.length + 1).split('/');
        for (let i = 1; i < parts.length; i++) out.set(parts.slice(0, i).join('/'), true);
        out.set(parts.join('/'), dirs.has(p));
      }
      return [...out].map(([path, dir]) => ({ path, dir })).sort((a, b) => a.path.localeCompare(b.path));
    },
    async createFile(path) {
      if (files.has(path)) throw new FileError('exists', path);
      write(path, '');
    },
    async createDir(path) {
      if (dirs.has(path)) throw new FileError('exists', path);
      dirs.add(path);
    },
    async countLinkUpdates(from) {
      return state.linkCounts[from] ?? 0;
    },
    async askUpdateLinks(name, count) {
      state.asked.push(`links:${name}:${count}`);
      return state.updateLinksAnswer;
    },
    async renamePath(from, to, updateLinks) {
      state.renames.push({ from, to, updateLinks });
      const taken = files.has(to) || dirs.has(to) || [...files.keys()].some((p) => p.startsWith(`${to}/`));
      if (taken) throw new FileError('exists', to);
      for (const [p, f] of [...files]) {
        if (p === from || p.startsWith(`${from}/`)) {
          files.delete(p);
          files.set(to + p.slice(from.length), f);
        }
      }
      for (const d of [...dirs]) {
        if (d === from || d.startsWith(`${from}/`)) {
          dirs.delete(d);
          dirs.add(to + d.slice(from.length));
        }
      }
      return updateLinks ? (state.linkUpdated[from] ?? []) : [];
    },
    async trashPath(path) {
      for (const p of [...files.keys()]) if (p === path || p.startsWith(`${path}/`)) files.delete(p);
      for (const d of [...dirs]) if (d === path || d.startsWith(`${path}/`)) dirs.delete(d);
    },
    async watch(specs) {
      state.watched.push(specs);
    },
    onFsChanged: async () => () => {},
    async askTrash(name) {
      state.asked.push(`trash:${name}`);
      return state.trashAnswer;
    },
    async revealInDir() {},
    async indexOpen(root) {
      state.indexRoot = root;
    },
    async noteNames() {
      const root = state.indexRoot;
      if (!root) return [];
      return [...files.keys()]
        .filter((p) => p.startsWith(`${root}/`) && p.endsWith('.md'))
        .map((p) => {
          const rel = p.slice(root.length + 1);
          return { rel, stem: rel.slice(rel.lastIndexOf('/') + 1, -3), title: null, aliases: [] };
        });
    },
    backlinks: async () => ({ linked: [], unlinked: [] }),
    search: async () => ({ hits: [], totalNotes: 0, totalMatches: 0, elapsedMs: 0 }),
    tags: async () => [],
    notesWithTag: async () => [],
    onIndexChanged: async () => () => {},
    async reviewGet(path) {
      return { baseline: state.baselines.get(path) ?? null, queued: state.queue.get(path) ?? null };
    },
    async baselineSet(path, text) {
      if (text === null) state.baselines.delete(path);
      else state.baselines.set(path, text);
    },
    async queueSet(path, content) {
      const item = state.queue.get(path);
      if (content === null || !item) state.queue.delete(path);
      else state.queue.set(path, { ...item, content });
    },
    queueList: async () => [...state.queue.values()],
    annotationsGet: async (path) => state.annotations.get(path) ?? [],
    async annotationsSave(path, list) {
      state.annotations.set(path, list);
    },
    agentsGet: async () => state.agents,
    activityGet: async () => state.activity,
    vaultConfigGet: async () => state.config,
    async vaultConfigSet(config) {
      state.config = config;
    },
    mcpCommand: async () => '/opt/zyrite',
    menuLocalize: async () => {},
    onOpenSettings: async () => () => {},
    onOpenPath: async () => () => {},
    mcpAccessList: async () => structuredClone(state.access),
    async mcpAccessAnswer(id, allow) {
      const req = state.access.requests.find((r) => r.id === id);
      state.access.requests = state.access.requests.filter((r) => r.id !== id);
      if (allow && req) {
        state.access.grants.push({ id: `g-${id}`, name: req.name, exe: req.exe, write: true, directWrite: false, createdMs: 1, valid: true });
      }
    },
    async mcpGrantSet(id, write, directWrite) {
      const g = state.access.grants.find((x) => x.id === id);
      if (g) Object.assign(g, { write, directWrite: directWrite && write });
    },
    async mcpGrantRevoke(id) {
      state.access.grants = state.access.grants.filter((g) => g.id !== id);
    },
    onDataChanged: async () => () => {},
    async aiKeySet(id, key) {
      state.keys.set(id, key);
    },
    aiKeyHas: async (id) => state.keys.has(id),
    async aiKeyDelete(id) {
      state.keys.delete(id);
    },
    async aiChat(id, _p, _k, messages) {
      state.aiRequests.push(messages);
      // 把回答拆成两段推送
      setTimeout(() => {
        const answer = state.aiAnswer;
        const half = Math.ceil(answer.length / 2);
        for (const fn of aiListeners) fn({ id, delta: answer.slice(0, half), done: false });
        for (const fn of aiListeners) fn({ id, delta: answer.slice(half), done: false });
        for (const fn of aiListeners) fn({ id, text: answer, done: true });
      }, 0);
    },
    async aiCancel() {},
    async onAiEvent(fn) {
      aiListeners.add(fn);
      return () => aiListeners.delete(fn);
    },
    aiIndex: async () => ({ chunks: 0, embedded: 0 }),
    onAiIndex: async () => () => {},
    aiRetrieve: async () => state.passages,
  };
  return { b, state, write };
}

export function resetStore() {
  activeEditor.current = null;
  activeEditor.docId = -1;
  useApp.setState({
    ...defaultSettings,
    filePath: null,
    text: '',
    savedText: '',
    stamp: null,
    dirty: false,
    docId: 0,
    notice: null,
    folder: null,
    recent: [],
    palette: null,
    settingsTab: null,
    tree: null,
    expanded: {},
    expandedFor: null,
    renaming: null,
    keepView: false,
    noteNames: null,
    indexVersion: 0,
    review: null,
    reviewFocus: 0,
    merge: null,
    agentVersion: 0,
    access: { grants: [], requests: [] },
    annotationVersion: 0,
    annotations: [],
    annFilter: 'all',
    annMargin: false,
    aiRewrite: null,
    composer: null,
  });
}
