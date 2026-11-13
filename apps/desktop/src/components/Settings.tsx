import { themeOrder, themes, type ThemeId } from '@zyrite/themes';
import { type ReactNode, useEffect, useState } from 'react';
import { locale, t } from '../i18n';
import type { AgentInfo, VaultConfig } from '../lib/backend';
import { loadAccess, revokeGrant, setGrant } from '../lib/access';
import { deps } from '../lib/document';
import { type SettingsTab, useApp, useBinding } from '../store';
import { AiSettings } from './AiSettings';
import { ExportSettings, ImageSettings, ShortcutSettings, ThemeImport } from './MoreSettings';

/**
 * 设置：左侧分类，右侧一行一项（标签 180px + 控件），细线分隔。
 * 应用级设置存在本机（zustand persist）；MCP 权限和审阅开关按库存在 `.zyrite/config.json`。
 */
export function Settings() {
  const tab = useApp((s) => s.settingsTab);
  useEffect(() => {
    if (!tab) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement).closest?.('input, textarea, select')) {
        useApp.setState({ settingsTab: null });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab]);
  if (!tab) return null;
  const tabs: [SettingsTab, string][] = [
    ['general', t.setGeneral],
    ['theme', t.setTheme],
    ['ai', t.setAi],
    ['mcp', t.setMcp],
    ['image', t.setImage],
    ['export', t.setExport],
    ['shortcuts', t.setShortcuts],
  ];
  return (
    <div className="settings" role="dialog" aria-label={t.settings}>
      <nav className="settings-nav" aria-label={t.settings}>
        <h1>{t.settings}</h1>
        {tabs.map(([id, label]) => (
          <button key={id} type="button" aria-current={tab === id} onClick={() => useApp.setState({ settingsTab: id })}>
            {label}
          </button>
        ))}
        <button type="button" className="settings-close" onClick={() => useApp.setState({ settingsTab: null })}>
          ← {t.close} <span className="muted">Esc</span>
        </button>
      </nav>
      <div className="settings-body">
        {tab === 'general' && <General />}
        {tab === 'theme' && <Theme />}
        {tab === 'ai' && <AiSettings />}
        {tab === 'mcp' && <Mcp />}
        {tab === 'image' && <ImageSettings />}
        {tab === 'export' && <ExportSettings />}
        {tab === 'shortcuts' && <ShortcutSettings />}
      </div>
    </div>
  );
}

export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-label">{label}</div>
      <div className="settings-control">
        {children}
        {hint && <p className="settings-hint">{hint}</p>}
      </div>
    </div>
  );
}

export function Choice<T extends string>(props: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void }) {
  return (
    <div className="settings-choice" role="radiogroup">
      {props.options.map(([v, label]) => (
        <label key={v}>
          <input type="radio" checked={props.value === v} onChange={() => props.onChange(v)} />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

export function Check(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="settings-check">
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

function General() {
  const s = useApp();
  return (
    <>
      <h2>{t.setGeneral}</h2>
      <Row label={t.openWith} hint={t.switchHint(useBinding('edition.toggle'))}>
        <Choice
          value={s.defaultEdition}
          onChange={(v) => useApp.setState({ defaultEdition: v })}
          options={[
            [
              'simple',
              <>
                <b>{t.editionSimple}</b> <span className="muted">{t.simpleDesc}</span>
              </>,
            ],
            [
              'full',
              <>
                <b>{t.editionFull}</b> <span className="muted">{t.fullDesc}</span>
              </>,
            ],
          ]}
        />
      </Row>
      <Row label={t.panes} hint={t.panesHint}>
        <Check checked={s.showSource} onChange={() => s.toggleSource()} label={t.paneSource} />
        <Check checked={s.showPreview} onChange={() => s.togglePreview()} label={t.panePreview} />
      </Row>
      <Row label={t.soloSource}>
        <Choice
          value={s.soloSource}
          onChange={(v) => useApp.setState({ soloSource: v })}
          options={[
            [
              'plain',
              <>
                <b>{t.soloPlain}</b> <span className="muted">{t.soloPlainDesc}</span>
              </>,
            ],
            [
              'live',
              <>
                <b>{t.soloLive}</b> <span className="muted">{t.soloLiveDesc}</span>
              </>,
            ],
          ]}
        />
      </Row>
      <Row label={t.markdownSyntax} hint={t.subscriptTildeHint}>
        <Check checked={s.subscript} onChange={(v) => useApp.setState({ subscript: v })} label={t.subscriptTilde} />
      </Row>
      <Row label={t.language} hint={t.languageReload}>
        <Choice
          value={s.language}
          onChange={(v) => {
            useApp.setState({ language: v });
            // 文案在启动时确定，换语言要重新加载界面
            setTimeout(() => window.location.reload(), 50);
          }}
          options={[
            ['en', 'English'],
            ['zh-CN', '简体中文'],
            ['system', t.followSystem],
          ]}
        />
      </Row>
    </>
  );
}

function ThemeSelect({ value, onChange }: { value: ThemeId; onChange: (v: ThemeId) => void }) {
  return (
    <select className="settings-select" value={value} onChange={(e) => onChange(e.target.value as ThemeId)}>
      {themeOrder.map((id) => (
        <option key={id} value={id}>
          {themes[id].name[locale]}
        </option>
      ))}
    </select>
  );
}

function Theme() {
  const pref = useApp((s) => s.themePref);
  const fontSize = useApp((s) => s.fontSize);
  const lineWidth = useApp((s) => s.lineWidth);
  const lineHeight = useApp((s) => s.lineHeight);
  const typora = useApp((s) => s.typoraTheme);
  const set = (p: Partial<typeof pref>) => useApp.setState({ themePref: { ...pref, ...p } });
  return (
    <>
      <h2>{t.setTheme}</h2>
      <Row label={t.themeFixed}>
        <div className="theme-swatches">
          {themeOrder.map((id) => {
            const th = themes[id];
            return (
              <button
                key={id}
                type="button"
                aria-pressed={!typora && !pref.followSystem && pref.theme === id}
                onClick={() => useApp.setState({ themePref: { ...pref, followSystem: false, theme: id }, typoraTheme: null })}
                // 左边一条是侧栏色：信号主题的深色侧栏也能一眼看出来
                style={{
                  background: th.colors.bg,
                  color: th.colors.text,
                  borderColor: th.colors.hair,
                  boxShadow: `inset 16px 0 0 ${th.colors.side}`,
                  paddingLeft: 16,
                  fontFamily: th.fontBody,
                }}
              >
                {th.name[locale]}
              </button>
            );
          })}
        </div>
      </Row>
      <Row label={t.themeFollowSystem}>
        <Check checked={pref.followSystem} onChange={(v) => set({ followSystem: v })} label={t.themeFollowSystem} />
        {pref.followSystem && (
          <div className="settings-inline">
            {t.themeLight} <ThemeSelect value={pref.light} onChange={(v) => set({ light: v })} /> {t.themeDark}{' '}
            <ThemeSelect value={pref.dark} onChange={(v) => set({ dark: v })} />
          </div>
        )}
      </Row>
      <Row label={t.fontSize}>
        <input
          className="settings-range"
          type="range"
          min={13}
          max={22}
          value={fontSize}
          onChange={(e) => useApp.setState({ fontSize: Number(e.target.value) })}
        />{' '}
        {fontSize}px
      </Row>
      <Row label={t.lineWidth}>
        <input
          className="settings-range"
          type="range"
          min={560}
          max={1000}
          step={20}
          value={lineWidth}
          onChange={(e) => useApp.setState({ lineWidth: Number(e.target.value) })}
        />{' '}
        {lineWidth}px
      </Row>
      <Row label={t.lineHeight}>
        <input
          className="settings-range"
          type="range"
          min={1.4}
          max={2.2}
          step={0.05}
          value={lineHeight}
          onChange={(e) => useApp.setState({ lineHeight: Number(e.target.value) })}
        />{' '}
        {lineHeight.toFixed(2)}
      </Row>
      <ThemeImport />
    </>
  );
}

function CopyBlock({ label, code, hint }: { label: string; code: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Row label={label} hint={hint}>
      <div className="settings-code">
        <pre>{code}</pre>
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? t.copied : t.copy}
        </button>
      </div>
    </Row>
  );
}

const when = (ms: number) => new Date(ms).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** 已允许的程序：权限、最近访问、撤销 */
function Grants() {
  const grants = useApp((s) => s.access.grants);
  const agentVersion = useApp((s) => s.agentVersion);
  useEffect(() => {
    void loadAccess();
  }, [agentVersion]);
  return (
    <Row label={t.grantsTitle}>
      {grants.length === 0 && <p className="muted">{t.grantsNone}</p>}
      {grants.map((g) => (
        <div key={g.id} className="grant">
          <div className="grant-head">
            <strong>{g.name}</strong>
            <span className="muted">{g.lastAccessMs ? t.grantLast(when(g.lastAccessMs)) : t.grantNever}</span>
            <button type="button" className="text-button inline" onClick={() => void revokeGrant(g.id)}>
              {t.grantRevoke}
            </button>
          </div>
          <div className="grant-exe mono muted">{g.exe || t.accessUnknownProgram}</div>
          {g.valid ? (
            <div className="grant-perms">
              <Check checked={g.write} label={t.grantWrite} onChange={(v) => void setGrant(g, v, g.directWrite)} />
              <Check checked={g.directWrite} disabled={!g.write} label={t.grantDirect} onChange={(v) => void setGrant(g, g.write, v)} />
            </div>
          ) : (
            <p className="settings-hint">{t.grantInvalid}</p>
          )}
        </div>
      ))}
    </Row>
  );
}

const shellQuote = (s: string) => (/^[\w./:-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);

function Mcp() {
  const folder = useApp((s) => s.folder);
  const followWriting = useApp((s) => s.followWriting);
  const agentVersion = useApp((s) => s.agentVersion);
  const [config, setConfig] = useState<VaultConfig | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [exe, setExe] = useState('zyrite');

  useEffect(() => {
    void deps.backend.mcpCommand().then(setExe);
  }, []);
  useEffect(() => {
    if (!folder) return;
    void deps.backend.vaultConfigGet().then(setConfig);
    void deps.backend.agentsGet().then(setAgents);
  }, [folder, agentVersion]);

  if (!folder) {
    return (
      <>
        <h2>{t.setMcp}</h2>
        <p className="muted">{t.mcpNeedFolder}</p>
      </>
    );
  }
  const update = (fn: (c: VaultConfig) => VaultConfig) => {
    if (!config) return;
    const next = fn(config);
    setConfig(next);
    void deps.backend.vaultConfigSet(next);
  };
  const args = ['mcp', '--vault', folder];
  const claude = `claude mcp add zyrite -- ${[exe, ...args].map(shellQuote).join(' ')}`;
  const cursor = JSON.stringify({ mcpServers: { zyrite: { command: exe, args } } }, null, 2);
  const codex = `[mcp_servers.zyrite]\ncommand = ${JSON.stringify(exe)}\nargs = ${JSON.stringify(args)}`;

  return (
    <>
      <h2>{t.setMcp}</h2>
      <Row label={t.mcpServer}>{t.mcpStatus(agents.length)}</Row>
      {config && (
        <Row label={t.agentCan} hint={t.agentCanHint}>
          <Check checked={config.mcp.read} label={t.permRead} onChange={(v) => update((c) => ({ ...c, mcp: { ...c.mcp, read: v } }))} />
          <Check checked={config.mcp.write} label={t.permWrite} onChange={(v) => update((c) => ({ ...c, mcp: { ...c.mcp, write: v } }))} />
          <Check
            checked={config.mcp.directWrite}
            label={t.permDirect}
            onChange={(v) => update((c) => ({ ...c, mcp: { ...c.mcp, directWrite: v } }))}
          />
          <Check checked disabled label={t.permVaultOnly} onChange={() => {}} />
        </Row>
      )}
      <Grants />
      {config && (
        <Row label={t.review} hint={t.reviewQueueDesc}>
          <Check
            checked={config.review.enabled}
            label={t.reviewQueue}
            onChange={(v) => update((c) => ({ ...c, review: { enabled: v } }))}
          />
          <Check checked={followWriting} label={t.followWriting} onChange={(v) => useApp.setState({ followWriting: v })} />
        </Row>
      )}
      <CopyBlock label={t.connectTo('Claude Code')} code={claude} />
      <CopyBlock label={t.connectTo('Cursor')} code={cursor} hint={t.connectHintCursor} />
      <CopyBlock label={t.connectTo('Codex')} code={codex} hint={t.connectHintCodex} />
    </>
  );
}
