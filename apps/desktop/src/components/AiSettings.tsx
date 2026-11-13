import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { complete, PRESETS, type ProviderConfig, presetName, testPrompt } from '../lib/ai';
import { deps } from '../lib/document';
import { useApp } from '../store';
import { Row } from './Settings';

const newId = () => `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 一个角色（改写和问答 / 向量）的模型配置：预设、地址、模型名、key（存系统钥匙串） */
function ProviderEditor({
  label,
  value,
  presets,
  onChange,
  test,
}: {
  label: string;
  value: ProviderConfig | null;
  presets: Omit<ProviderConfig, 'id'>[];
  onChange: (p: ProviderConfig | null) => void;
  test: (p: ProviderConfig) => Promise<string>;
}) {
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    if (value) void deps.backend.aiKeyHas(value.id).then(setHasKey);
  }, [value?.id]);

  const pick = (name: string) => {
    if (!name) return onChange(null);
    const preset = presets.find((p) => p.name === name)!;
    onChange({ ...preset, id: value?.id ?? newId() });
  };
  const saveKey = async () => {
    if (!value || !key.trim()) return;
    await deps.backend.aiKeySet(value.id, key.trim());
    setKey('');
    setHasKey(true);
  };

  return (
    <Row label={label}>
      <div className="settings-inline">
        <select className="settings-select" value={value && presets.some((p) => p.name === presetName(value.name)) ? presetName(value.name) : ''} onChange={(e) => pick(e.target.value)}>
          <option value="">{value ? t.aiCustom : t.aiNotSet}</option>
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        {value && (
          <button type="button" className="text-button inline" onClick={() => onChange(null)}>
            {t.aiRemove}
          </button>
        )}
      </div>
      {value && (
        <div className="settings-fields">
          <label>
            {t.aiBaseUrl}
            <input className="settings-input" value={value.baseUrl} spellCheck={false} onChange={(e) => onChange({ ...value, baseUrl: e.target.value })} />
          </label>
          <label>
            {t.aiModel}
            <input className="settings-input" value={value.model} spellCheck={false} onChange={(e) => onChange({ ...value, model: e.target.value })} />
          </label>
          {value.kind === 'openai' && (
            <label>
              API key
              <input
                className="settings-input"
                type="password"
                value={key}
                placeholder={hasKey ? t.aiKeySaved : 'sk-…'}
                autoComplete="off"
                onChange={(e) => setKey(e.target.value)}
                onBlur={() => void saveKey()}
                onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
              />
            </label>
          )}
          <div className="settings-inline">
            <button
              type="button"
              className="text-button inline"
              onClick={() => {
                setStatus({ text: t.aiTesting });
                void saveKey()
                  .then(() => test(value))
                  .then((r) => setStatus({ text: t.aiTestOk(r.slice(0, 60)) }))
                  .catch((e) => setStatus({ text: String(e instanceof Error ? e.message : e), error: true }));
              }}
            >
              {t.aiTest}
            </button>
            {status && <span className={status.error ? 'status-error' : 'muted'}>{status.text}</span>}
          </div>
        </div>
      )}
    </Row>
  );
}

/** 设置 › AI 模型 */
export function AiSettings() {
  const ai = useApp((s) => s.ai);
  const set = (patch: Partial<typeof ai>) => useApp.setState({ ai: { ...ai, ...patch } });

  return (
    <>
      <h2>{t.setAi}</h2>
      <p className="muted">{t.aiIntro}</p>
      <ProviderEditor
        label={t.aiChatRole}
        value={ai.chat}
        presets={PRESETS}
        onChange={(chat) => set({ chat })}
        test={(p) => complete(p, testPrompt())}
      />
    </>
  );
}
