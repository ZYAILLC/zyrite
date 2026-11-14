import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { locale, t } from '../i18n';
import {
  type AiSettings as AiSettingsValue,
  CUSTOM_KINDS,
  complete,
  draftService,
  localName,
  PROVIDER_GROUPS,
  PROVIDERS,
  type ProviderConfig,
  type ProviderEntry,
  type ProviderGroup,
  type ProviderKind,
  providerById,
  serviceName,
  testPrompt,
  wireProvider,
} from '../lib/ai';
import { deps } from '../lib/document';
import { useApp } from '../store';

/**
 * 设置 › AI 模型：左边是已添加的服务和服务商目录（按量 API、订阅、本地与自定义），
 * 右边是选中项的表单。选目录里的服务商 → 填密钥、地址、模型 → 添加服务；选已添加的服务 → 直接改。
 * 密钥存系统钥匙串（按服务 id），界面只知道"有没有"。
 */

type Selection = { service: string } | { provider: string };

const GROUP_TITLE: Record<ProviderGroup, () => string> = {
  payg: () => t.aiGroupPayg,
  subscription: () => t.aiGroupSubscription,
  local: () => t.aiGroupLocal,
};

const KIND_LABEL: Record<ProviderKind, () => string> = {
  openai: () => t.aiKindOpenai,
  anthropic: () => 'Anthropic',
  ollama: () => 'Ollama',
  chatgpt: () => 'ChatGPT',
};

const errText = (e: unknown) => String(e instanceof Error ? e.message : e);

function setAi(patch: Partial<AiSettingsValue>) {
  useApp.setState((s) => ({ ai: { ...s.ai, ...patch } }));
}

function ListItem({ mark, name, sub, tag, active, onClick }: { mark: string; name: string; sub?: string; tag?: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className="ai-svc-item" aria-current={active} onClick={onClick}>
      <span className="ai-mark" aria-hidden>
        {mark}
      </span>
      <span className="ai-svc-name">
        {name}
        {sub && <small>{sub}</small>}
      </span>
      {tag && <span className="ai-tag">{tag}</span>}
    </button>
  );
}

/** 一个服务的表单：新添加（来自目录）或编辑已添加的 */
function ServiceForm({
  entry,
  initial,
  isNew,
  inUse,
  onAdded,
  onRemoved,
}: {
  entry: ProviderEntry;
  initial: ProviderConfig;
  isNew: boolean;
  inUse: boolean;
  onAdded: (p: ProviderConfig) => void;
  onRemoved: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState<'sync' | 'test' | 'auth' | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const keySaved = useRef(false);
  const added = useRef(false);
  const listId = useId();
  const name = isNew ? localName(entry, locale) : serviceName(draft);
  const custom = entry.id === 'custom';
  const needsKey = entry.auth === 'apiKey' || entry.auth === 'optionalKey';
  const oauth = entry.auth === 'oauth';

  useEffect(() => {
    void deps.backend.aiKeyHas(initial.id).then(setHasKey);
    // 新服务没添加就离开了：删掉为它存的密钥
    return () => {
      if (isNew && keySaved.current && !added.current) void deps.backend.aiKeyDelete(initial.id);
    };
  }, [initial.id, isNew]);

  const update = (patch: Partial<ProviderConfig>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (!isNew) setAi({ services: useApp.getState().ai.services.map((s) => (s.id === next.id ? next : s)) });
  };

  const saveKey = async () => {
    if (!key.trim()) return;
    await deps.backend.aiKeySet(draft.id, key.trim());
    keySaved.current = true;
    setKey('');
    setHasKey(true);
  };

  const sync = async () => {
    setBusy('sync');
    setStatus({ text: t.aiSyncing });
    try {
      await saveKey();
      const models = await deps.backend.aiModels(wireProvider(draft), draft.id);
      update({ models, model: draft.model || models[0] || '' });
      setStatus({ text: t.aiModelsCount(models.length) });
    } catch (e) {
      setStatus({ text: errText(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setStatus({ text: t.aiTesting });
    try {
      await saveKey();
      const r = await complete(draft, testPrompt());
      setStatus({ text: t.aiTestOk(r.slice(0, 60)) });
    } catch (e) {
      setStatus({ text: errText(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    await saveKey();
    added.current = true;
    onAdded({ ...draft, name: custom ? draft.name.trim() || t.aiCustomName : name });
  };

  const remove = async () => {
    await deps.backend.aiKeyDelete(draft.id);
    onRemoved();
  };

  // 浏览器登录授权：OrcaRouter 等换 API 密钥；ChatGPT 套餐存登录状态。成功后顺便同步模型列表
  const signIn = async () => {
    setBusy('auth');
    setStatus({ text: t.aiAuthWaiting(name) });
    try {
      await deps.backend.aiSignIn(entry.id, draft.id);
      keySaved.current = true;
      setKey('');
      setHasKey(true);
      setStatus({ text: t.aiAuthDone });
      try {
        const models = await deps.backend.aiModels(wireProvider(draft), draft.id);
        update({ models, model: draft.model || models[0] || '' });
      } catch {
        // 模型列表拿不到不影响登录，可以手动填模型名
      }
    } catch (e) {
      setStatus({ text: errText(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const keyReady = entry.auth === 'apiKey' ? hasKey || !!key.trim() : entry.auth === 'oauth' ? hasKey : true;
  const canAdd = !!draft.baseUrl.trim() && !!draft.model.trim() && keyReady;
  const region = entry.regions?.find((r) => r.baseUrl === draft.baseUrl);

  return (
    <div className="ai-svc-form">
      <div className="ai-svc-head">
        <span className="ai-mark large" aria-hidden>
          {entry.mark}
        </span>
        <h3>{name}</h3>
      </div>
      {entry.group === 'subscription' && !oauth && <p className="settings-hint">{t.aiPlanNote}</p>}

      {(entry.connect || oauth) && (
        <div className="ai-field">
          <div className="ai-auth-row">
            <button type="button" className="ai-connect" disabled={busy !== null} onClick={() => void signIn()}>
              {oauth ? (hasKey ? t.aiSignInAgain : t.aiSignIn) : t.aiConnect(name)}
            </button>
            {busy === 'auth' && (
              <button type="button" className="text-button inline" onClick={() => void deps.backend.aiSignInCancel()}>
                {t.cancel}
              </button>
            )}
          </div>
          <p className="settings-hint">{oauth ? (hasKey ? t.aiChatgptSignedIn : t.aiChatgptNote) : t.aiConnectNote(name)}</p>
          {oauth && (
            <button type="button" className="ai-link" onClick={() => void deps.backend.openExternal('https://chatgpt.com/settings/usage')}>
              {t.aiManageUsage} ↗
            </button>
          )}
        </div>
      )}

      <fieldset className="ai-fields">
        {custom && (
          <>
            <label className="ai-field">
              <span>{t.aiServiceName}</span>
              <input className="settings-input" value={draft.name} placeholder={t.aiCustomName} onChange={(e) => update({ name: e.target.value })} />
            </label>
            <label className="ai-field">
              <span>{t.aiProtocol}</span>
              <select className="settings-select" value={draft.kind} onChange={(e) => update({ kind: e.target.value as ProviderKind, models: [] })}>
                {CUSTOM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]()}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {needsKey && (
          <div className="ai-field">
            <label htmlFor={`${listId}-key`}>
              {t.aiApiKey}
              {entry.auth === 'optionalKey' && <span className="muted"> · {t.aiKeyOptional}</span>}
            </label>
            <input
              id={`${listId}-key`}
              className="settings-input"
              type="password"
              value={key}
              placeholder={hasKey ? t.aiKeySaved : t.aiKeyNotSet}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setKey(e.target.value)}
              onBlur={() => void saveKey()}
              onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
            />
            {entry.keyUrl && (
              <button type="button" className="ai-link" onClick={() => void deps.backend.openExternal(entry.keyUrl!)}>
                {t.aiGetKey(name)} ↗
              </button>
            )}
          </div>
        )}

        {entry.regions && (
          <label className="ai-field">
            <span>{t.aiRegion}</span>
            <select className="settings-select" value={region?.baseUrl ?? ''} onChange={(e) => e.target.value && update({ baseUrl: e.target.value, models: [] })}>
              {!region && <option value="">{t.aiBaseUrl}</option>}
              {entry.regions.map((r) => (
                <option key={r.baseUrl} value={r.baseUrl}>
                  {localName(r, locale)}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="ai-field">
          <span>{t.aiBaseUrl}</span>
          <input className="settings-input mono" value={draft.baseUrl} spellCheck={false} placeholder="https://…/v1" onChange={(e) => update({ baseUrl: e.target.value })} />
        </label>

        <div className="ai-field">
          <div className="ai-field-head">
            <label htmlFor={`${listId}-model`}>{t.aiModel}</label>
            <button type="button" className="ai-ghost" disabled={busy !== null || !draft.baseUrl.trim()} onClick={() => void sync()}>
              ↻ {t.aiSyncModels}
            </button>
          </div>
          <input
            id={`${listId}-model`}
            className="settings-input"
            list={`${listId}-models`}
            value={draft.model}
            spellCheck={false}
            placeholder={t.aiModelPlaceholder}
            onChange={(e) => update({ model: e.target.value })}
          />
          <datalist id={`${listId}-models`}>
            {draft.models?.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p className="settings-hint">{draft.models?.length ? t.aiModelsCount(draft.models.length) : t.aiNoModels}</p>
        </div>
      </fieldset>

      {status && (
        <p className={status.error ? 'status-error' : 'muted'} role="status">
          {status.text}
        </p>
      )}

      <div className="ai-svc-actions">
        {!isNew && (
          <button type="button" className="text-button inline danger" onClick={() => void remove()}>
            {t.aiRemove}
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="ai-ghost" disabled={busy !== null || !draft.model.trim() || !draft.baseUrl.trim()} onClick={() => void test()}>
          {t.aiTest}
        </button>
        {isNew ? (
          <button type="button" className="primary" disabled={!canAdd} onClick={() => void add()}>
            {t.aiAddService}
          </button>
        ) : inUse ? (
          <span className="muted">{t.aiInUse}</span>
        ) : (
          <button type="button" className="primary" onClick={() => setAi({ chatId: draft.id })}>
            {t.aiUseForRewrite}
          </button>
        )}
      </div>
    </div>
  );
}

/** 设置 › AI 模型 */
export function AiSettings() {
  const ai = useApp((s) => s.ai);
  const [sel, setSel] = useState<Selection>(() => (ai.services.length ? { service: ai.chatId ?? ai.services[0]!.id } : { provider: PROVIDERS[0]!.id }));

  const service = 'service' in sel ? ai.services.find((s) => s.id === sel.service) : undefined;
  const entry = 'provider' in sel ? providerById(sel.provider) : service ? (providerById(service.provider) ?? providerById('custom')) : undefined;
  // 新服务的草稿：换了选中的服务商才重新生成（id 跟着变，表单随之重置）
  const providerId = 'provider' in sel ? sel.provider : null;
  const draft = useMemo(() => {
    const e = providerById(providerId ?? undefined);
    return e ? draftService(e) : null;
  }, [providerId]);

  const added = (p: ProviderConfig) => {
    const { services, chatId } = useApp.getState().ai;
    setAi({ services: [...services, p], chatId: chatId ?? p.id });
    setSel({ service: p.id });
  };
  const removed = (id: string) => {
    const { services, chatId } = useApp.getState().ai;
    const rest = services.filter((s) => s.id !== id);
    setAi({ services: rest, chatId: chatId === id ? (rest[0]?.id ?? null) : chatId });
    setSel(rest[0] ? { service: rest[0].id } : { provider: PROVIDERS[0]!.id });
  };

  return (
    <>
      <h2>{t.setAi}</h2>
      <p className="muted">{t.aiIntro}</p>
      <div className="ai-svc">
        <nav className="ai-svc-list" aria-label={t.setAi}>
          {ai.services.length > 0 && (
            <section>
              <h4>{t.aiAdded}</h4>
              {ai.services.map((s) => (
                <ListItem
                  key={s.id}
                  mark={providerById(s.provider)?.mark ?? '+'}
                  name={serviceName(s)}
                  sub={s.model}
                  tag={s.id === ai.chatId ? '✓' : undefined}
                  active={'service' in sel && sel.service === s.id}
                  onClick={() => setSel({ service: s.id })}
                />
              ))}
            </section>
          )}
          {PROVIDER_GROUPS.map((g) => (
            <section key={g}>
              <h4>{GROUP_TITLE[g]()}</h4>
              {PROVIDERS.filter((p) => p.group === g).map((p) => (
                <ListItem
                  key={p.id}
                  mark={p.mark}
                  name={localName(p, locale)}
                  active={'provider' in sel && sel.provider === p.id}
                  onClick={() => setSel({ provider: p.id })}
                />
              ))}
            </section>
          ))}
        </nav>
        <div className="ai-svc-detail">
          {service && entry ? (
            <ServiceForm key={service.id} entry={entry} initial={service} isNew={false} inUse={service.id === ai.chatId} onAdded={added} onRemoved={() => removed(service.id)} />
          ) : entry && draft ? (
            <ServiceForm key={draft.id} entry={entry} initial={draft} isNew inUse={false} onAdded={added} onRemoved={() => {}} />
          ) : null}
        </div>
      </div>
    </>
  );
}
