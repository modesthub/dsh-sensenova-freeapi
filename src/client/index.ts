/**
 * SenseNova 客户端插件入口（browser half）。
 *
 * 只做多账户连接配置所必需的事：
 *   1. 注册 `settings.sensenova` 文案命名空间（zh/en）；
 *   2. 桥接凭据面：优先宿主 `remote.credentials`，旧版退化为
 *      `connection.api.credentials`（与 @mars-sea/dsh-commandcode-provider 同构）；
 *   3. 用 `configForms.get('llm-sensenova')` 生成设置域，
 *      交给 SenseNovaSettingsController（领域层，无 JSX）；
 *   4. 注入 `settings.section`（设置页）与 `settings.models.provider-card`
 *      （Models 页卡片）两个槽。
 *
 * API key 一律经凭据域写入（credential-ref），页面不回显明文；host 是唯一事实
 * 来源，保存后立即热生效。
 */
import { SenseNovaSection } from './section';
import { SenseNovaProviderCard } from './card';
import {
  SENSENOVA_NS,
  createSnapshotStore,
  SenseNovaSettingsController,
  type CredentialsFace,
  type SettingsScope,
  type SenseNovaConfig,
} from './settings';
import { zh, en } from './locales';

/** 旧版 ApiProxy 凭据面（仅作退化路径）。 */
interface LegacyCredentialApi {
  describe(input: { refs: string[] }): Promise<{ result: { ok: boolean; value?: { credentials: Record<string, { configured: boolean; writable: boolean }> }; error?: unknown } }>;
  set(input: { ref: string; value: string }): Promise<{ result: { ok: boolean; error?: unknown } }>;
  unset(input: { ref: string }): Promise<{ result: { ok: boolean; error?: unknown } }>;
}

/** 最小 Cordis 上下文面，避免依赖缺失的 ui-slots / ui-primitives 包做类型检查。 */
interface ClientContextLike {
  slots: {
    inject(key: string, factory: () => () => void): () => void;
    register(options: unknown, component: unknown): unknown;
  };
  locale: {
    register(namespace: string, table: { zh: Record<string, string>; en: Record<string, string> }): void;
    bind(namespace: string): (key: string, params?: Record<string, string | number>) => string;
  };
  connection?: {
    api?: { credentials?: LegacyCredentialApi };
  };
  remote: {
    credentials: CredentialsFace;
    $on(event: string, listener: () => void): () => void;
  };
  /**
   * 设置域服务。
   *
   * 🔴 **0.1.7 改名**：`ctx.settingsScope`（`SettingsScopeBinder`）改为
   * `ctx.configForms`（`ConfigForms`），取域方法由 `bind({ namespace })` 改为
   * **`get(namespace)`**。旧的 `settingsScope` 在 0.1.7 的客户端 bundle 里已
   * **一个字节都不剩**（`grep -c settingsScope packages/client/ui-settings/lib/client.js → 0`），
   * 所以这不是口味问题：旧写法会让整段设置页抛 TypeError。
   */
  configForms: {
    get<T>(namespace: string): SettingsScope<T>;
  };
  get(name: string): unknown;
  effect(fn: () => (() => void) | void, label: string): void;
  inject(deps: string[], fn: (ctx: ClientContextLike) => void): void;
}

/** 把旧版 ApiProxy 凭据面适配为 CredentialsFace。 */
function adaptLegacyCredentials(legacy: LegacyCredentialApi | undefined): CredentialsFace | undefined {
  if (legacy === undefined) return undefined;
  return {
    describe: async (refs) => {
      const response = await legacy.describe({ refs });
      if (!response.result.ok) return { ok: false as const };
      const value = response.result.value?.credentials;
      return value === undefined ? { ok: true as const } : { ok: true as const, value };
    },
    set: async (ref, value) => {
      const response = await legacy.set({ ref, value });
      return response.result.ok ? { ok: true } : { ok: false, error: response.result.error };
    },
    unset: async (ref) => {
      const response = await legacy.unset({ ref });
      return response.result.ok ? { ok: true } : { ok: false, error: response.result.error };
    },
  };
}

function injectPageCss(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('dsh-sensenova-freeapi-css')) return;
  const tag = document.createElement('style');
  tag.id = 'dsh-sensenova-freeapi-css';
  tag.textContent = [
    '.sn-section{display:flex;flex-direction:column;gap:14px}',
    '.sn-title{font-size:16px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary,#222)}',
    '.sn-intro,.sn-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin:2px 0 0;line-height:1.5}',
    '.sn-readOnly,.sn-failed{font-size:12px;color:var(--dsw-alias-label-error,#d9534f);margin:0}',
    '.sn-saved{font-size:12px;color:var(--dsw-alias-label-success,#2e8b57);margin:0}',
    '.sn-unsaved{font-size:12px;color:var(--dsw-alias-label-warning,#b58900);margin:0}',
    /* 分组标题：隔开卡片区，强化分区感 */
    '.sn-groupTitle{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin:10px 0 -4px;padding:0 2px}',
    '.sn-groupTitle:first-of-type{margin-top:2px}',
    /* 卡片：更柔和的边框 + 层次背景 */
    '.sn-card{display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04))}',
    '.sn-cardCompact{padding:10px 14px}',
    '.sn-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
    '.sn-fieldHead{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}',
    '.sn-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#222);min-width:0}',
    '.sn-labelSmall{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#5c5c5c)}',
    '.sn-badges{display:inline-flex;gap:6px;align-items:center;flex:0 0 auto;min-width:0;white-space:nowrap}',
    '.sn-badge,.sn-badgeMuted,.sn-badgeActive{font-size:11px;padding:1px 8px;border-radius:999px;white-space:nowrap;line-height:17px}',
    '.sn-badge{background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,#5c5c5c);font-weight:500}',
    '.sn-badgeMuted{background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
    '.sn-badgeActive{background:var(--dsw-alias-button-primary-fill,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}',
    '.sn-input{box-sizing:border-box;width:100%;font-size:13px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#222);min-width:0}',
    '.sn-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}',
    'select.sn-input{appearance:none;cursor:pointer;padding-right:30px}',
    '.sn-activeAccountSelect{position:relative;flex:1 1 auto;min-width:0}',
    '.sn-activeAccountSelect>.sn-input{width:100%}',
    '.sn-selectChevron{position:absolute;right:8px;top:50%;width:14px;height:14px;transform:translateY(-50%);background-color:var(--dsw-alias-label-tertiary,#888f98);pointer-events:none;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2714%27 height=%2714%27 viewBox=%270 0 14 14%27 fill=%27none%27%3E%3Cpath d=%27M3 5.5 7 9l4-3.5%27 stroke=%27white%27 stroke-width=%271.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E") center / 14px 14px no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2714%27 height=%2714%27 viewBox=%270 0 14 14%27 fill=%27none%27%3E%3Cpath d=%27M3 5.5 7 9l4-3.5%27 stroke=%27white%27 stroke-width=%271.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E") center / 14px 14px no-repeat}',
    '.sn-textarea{display:block;line-height:1.45;min-height:88px;resize:vertical}',
    /* 账户列表：行间分隔更清晰 */
    '.sn-accountList{display:flex;flex-direction:column;gap:0;min-width:0}',
    '.sn-accountRow{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px 0}',
    '.sn-accountRow:first-child{padding-top:2px}',
    '.sn-accountRow+.sn-accountRow{border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}',
    '.sn-accountHead{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:nowrap}',
    '.sn-accountHead>.sn-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sn-accountActions{display:flex;align-items:center;gap:4px;flex:0 0 auto;min-width:0;white-space:nowrap}',
    '.sn-accountActions>.sn-badges{margin-right:4px}',
    /* 账户行字段：备注 / 密钥 并排（窄屏自动换行） */
    '.sn-accountFields{display:flex;flex-wrap:wrap;gap:8px 12px;min-width:0}',
    '.sn-accountField{display:flex;flex-direction:column;gap:4px;flex:1 1 200px;min-width:0}',
    /* 行内图标按钮 */
    '.sn-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:pointer}',
    '.sn-iconBtn:hover:not(:disabled){color:var(--dsw-alias-brand-primary,#3b82f6);background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.1))}',
    '.sn-iconBtn:disabled{opacity:.5;cursor:not-allowed}',
    '.sn-iconBtnDanger:hover:not(:disabled){color:var(--dsw-alias-label-error,#d9534f)}',
    '.sn-activeAccountControl{display:flex;align-items:center;gap:8px;min-width:0}',
    /* 文本链接按钮（次级操作） */
    '.sn-reset{font-size:12px;line-height:1.4;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8a8a8a);cursor:pointer;white-space:nowrap}',
    '.sn-reset:hover:not(:disabled){color:var(--dsw-alias-brand-primary,#3b82f6)}',
    '.sn-reset:disabled{opacity:.5;cursor:not-allowed}',
    /* 添加账户：带边框的次级按钮，突出于文本链接 */
    '.sn-btnAdd{font-size:12px;line-height:1.4;padding:3px 10px;border-radius:6px;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:var(--dsw-alias-label-secondary,#5c5c5c);cursor:pointer;white-space:nowrap}',
    '.sn-btnAdd:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-brand-primary,#3b82f6)}',
    '.sn-btnAdd:disabled{opacity:.5;cursor:not-allowed}',
    '.sn-btnPrimary{font-size:13px;line-height:1.4;padding:6px 14px;border-radius:6px;border:1px solid transparent;background:var(--dsw-alias-button-primary-fill,#3b82f6);color:var(--dsw-alias-label-primary-foreground,#fff);cursor:pointer}',
    '.sn-btnPrimary:hover:not(:disabled){filter:brightness(.94)}',
    '.sn-btnPrimary:disabled{opacity:.5;cursor:not-allowed}',
    '.sn-btnGhost{font-size:13px;line-height:1.4;padding:6px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:var(--dsw-alias-label-secondary,#5c5c5c);cursor:pointer}',
    '.sn-btnGhost:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-brand-primary,#3b82f6)}',
    '.sn-btnGhost:disabled{opacity:.5;cursor:not-allowed}',
    /* 底部：状态左置、操作右置，上边框收口 */
    '.sn-footer{display:flex;flex-direction:column;align-items:stretch;gap:8px;margin-top:2px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}',
    '.sn-footerStatus{display:flex;flex-direction:column;gap:2px;min-height:16px}',
    '.sn-footerActions{display:flex;align-items:center;justify-content:flex-end;gap:8px}',
    /* 高级设置折叠卡 */
    '.sn-advanced{gap:0;padding:0;overflow:hidden}',
    '.sn-advancedHeader{display:flex;align-items:center;width:100%;gap:8px;padding:12px 14px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#222);font:inherit;text-align:left;cursor:pointer}',
    '.sn-advancedHeader:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08))}',
    '.sn-advancedHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:-2px}',
    '.sn-advancedMeta{display:inline-flex;align-items:center;gap:8px;margin-left:auto;white-space:nowrap}',
    '.sn-advancedChevron{width:7px;height:7px;border-right:1.5px solid var(--dsw-alias-label-tertiary,#888f98);border-bottom:1.5px solid var(--dsw-alias-label-tertiary,#888f98);transform:rotate(45deg);transition:transform .15s ease}',
    '.sn-advancedChevronExpanded{transform:rotate(225deg)}',
    '.sn-advancedBody{display:flex;flex-direction:column;gap:10px;padding:0 14px 14px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));min-width:0}',
    '.sn-advancedBody[hidden]{display:none}',
    '.sn-models{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:8px;padding:10px;background:var(--dsw-alias-bg-layer-1,transparent);min-width:0}',
    /* 配额类 429 换 key 开关 */
    '.sn-toggle{width:16px;height:16px;margin:0;flex:0 0 auto;accent-color:var(--dsw-alias-brand-primary,#3b82f6);cursor:pointer}',
    '.sn-toggle:disabled{opacity:.5;cursor:not-allowed}',
    '.sn-providerCard{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-1,transparent);min-width:0}',
    /* 账户总览条 */
    '.sn-accountSummary{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}',
    '.sn-accountSummaryStats{font-size:12px;color:var(--dsw-alias-label-secondary,#5c5c5c);font-weight:500}',
    '.sn-accountSummaryActive{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary,#222);font-weight:600}',
    '.sn-accountSummaryNone{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
    '.sn-dotPulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary,#3b82f6);animation:sn-pulse 1.8s ease-in-out infinite}',
    '@keyframes sn-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}',
    '.sn-accountRow[data-sn-active="true"]{border-left:3px solid var(--dsw-alias-brand-primary,#3b82f6);padding-left:10px;margin-left:-3px;background:var(--dsw-alias-bg-layer-2,rgba(59,130,246,.06));border-radius:4px}',
    /* 错误记录诊断区块（只读运行数据，2026-09-18） */
    '.sn-linkButton{font-size:12px;color:var(--dsw-alias-brand-primary,#3b82f6);background:none;border:none;padding:2px 4px;cursor:pointer;border-radius:4px;font-family:inherit}',
    '.sn-linkButton:disabled{color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:default}',
    '.sn-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
    '.sn-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
    '.sn-diagnosticsBody{display:flex;flex-direction:column;gap:10px;min-width:0}',
    '.sn-diagnosticsStats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}',
    '.sn-diagnosticsStat{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));min-width:0}',
    '.sn-diagnosticsValue{font-size:20px;font-weight:600;line-height:1.2;color:var(--dsw-alias-label-primary,#222)}',
    '.sn-diagnosticsList{display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:8px;overflow:hidden}',
    // 🔴 2026-09-27：三列 → 五列（时间 / 类型 / 模型 / 账户 / API）。账户名与 ref 名
    // 都可能较长 ⇒ 这两个单元格配 `.sn-truncate` 做省略号，避免把窄面板撑破。
    '.sn-diagnosticsRow{display:grid;grid-template-columns:58px 1fr 1fr 72px 1.1fr;gap:10px;align-items:center;padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);min-width:0}',
    '.sn-diagnosticsList>div+div>.sn-diagnosticsRowButton{border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16))}',
    '.sn-diagnosticsRowButton{width:100%;border:none;background:none;text-align:left;cursor:pointer;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#222)}',
    '.sn-diagnosticsRowButton:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07))}',
    '.sn-diagnosticsCode{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sn-diagnosticsCode[data-kind="rate"]{color:var(--dsw-alias-label-warning,#b58900)}',
    // 请求数限流（rpm）与 rate 同色：两者都是「秒级窗口」，与 tpm（分钟级）在语义上区分开。
    '.sn-diagnosticsCode[data-kind="rpm"]{color:var(--dsw-alias-label-warning,#b58900)}',
    '.sn-diagnosticsDetail{display:flex;flex-direction:column;gap:6px;padding:8px 10px 10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05))}',
    '.sn-diagnosticsTags{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
    '.sn-diagnosticsMessage{margin:0;word-break:break-all}',
    '.sn-diagnosticsWarn{color:var(--dsw-alias-label-warning,#b58900)}',
    // 「当前模型 + 全部参数」面板（2026-09-23 Phase 5）。
    // ⚠️ 不能覆盖 `.sn-diagnosticsRow` 的列宽（那是错误记录面板的五列网格），
    // 所以这里用独立类 `.sn-miRow`。
    '.sn-miRow{display:grid;grid-template-columns:1.4fr auto 1fr;gap:10px;align-items:center;padding:6px 10px;font-size:12px;min-width:0}',
    '.sn-miList>div+div>.sn-miRow{border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16))}',
    '.sn-miBadge{justify-self:start;display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;line-height:1.6;white-space:nowrap}',
    '.sn-miBadgeHost{background:var(--dsw-alias-bg-success,rgba(60,160,90,.16));color:var(--dsw-alias-label-success,#2f7d4f)}',
    '.sn-miBadgeL2{background:var(--dsw-alias-bg-info,rgba(60,110,200,.14));color:var(--dsw-alias-label-info,#2c5fa8)}',
    '.sn-miBadgeNone{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
  ].join('\n');
  document.head.appendChild(tag);
}

/** 在给定的 ctx 上挂载两个槽，共享同一个设置控制器与快照 store。 */
function applyClientSurfaces(ctx: ClientContextLike, credentials: CredentialsFace): void {
  const scope = ctx.configForms.get<SenseNovaConfig>(SENSENOVA_NS);
  const controller = new SenseNovaSettingsController(scope, credentials);
  ctx.effect(() => () => controller.dispose(), 'dsh-sensenova-freeapi: settings controller');

  const store = createSnapshotStore(controller.state());
  controller.subscribe(() => store.set(controller.state()));

  // 宿主的凭据域提交（set/unset/外部编辑）后重读配置状态，刷新「已配置/可写」徽标。
  ctx.effect(() => ctx.remote.$on('credentials/reference-updated', () => {
    void controller.refreshCredentials();
  }), 'dsh-sensenova-freeapi: credential invalidations');

  const injected = () => ({
    hooks: { sensenovaSettings: store },
    edit: (field: Parameters<SenseNovaSettingsController['edit']>[0], text: string) => controller.edit(field, text),
    save: () => void controller.save(),
    discard: () => controller.discard(),
    addAccount: () => controller.addAccount(),
    removeAccount: (id: string) => controller.removeAccount(id),
    editAccountLabel: (id: string, text: string) => controller.editAccountLabel(id, text),
    editAccountKey: (id: string, text: string) => controller.editAccountKey(id, text),
    toggleAccountKeyClear: (id: string) => controller.toggleAccountKeyClear(id),
    editDefaultKey: (text: string) => controller.editDefaultKey(text),
    toggleDefaultKeyClear: () => controller.toggleDefaultKeyClear(),
    setActiveAccount: (id: string) => controller.setActiveAccount(id),
    setQuotaRotation: (on: boolean) => controller.setQuotaRotation(on),
    setErrorLog: (on: boolean) => controller.setErrorLog(on),
    refreshErrorLog: () => void controller.refreshErrorLog(),
    toggleErrorLogRow: (index: number) => controller.toggleErrorLogRow(index),
    refreshModelInfo: () => void controller.refreshModelInfo(),
    setRetryMode: (mode: 'normal' | 'always') => controller.setRetryMode(mode),
    editRetry: (field: Parameters<SenseNovaSettingsController['editRetry']>[0], text: string) =>
      controller.editRetry(field, text),
    editPool: (field: Parameters<SenseNovaSettingsController['editPool']>[0], text: string) =>
      controller.editPool(field, text),
  });

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'sensenova',
    order: 13,
    label: () => ctx.locale.bind('settings.sensenova')('nav'),
    locale: 'settings.sensenova',
    inject: injected,
  }, SenseNovaSection) as () => void);

  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: 'llm-sensenova',
    locale: 'settings.sensenova',
    inject: () => ({
      hooks: { sensenovaSettings: store },
      edit: (field: Parameters<SenseNovaSettingsController['edit']>[0], text: string) => controller.edit(field, text),
      save: () => void controller.save(),
    }),
  }, SenseNovaProviderCard) as () => void);
}

export const inject = ['slots', 'locale', 'connection', 'remote', 'configForms'];

export function apply(ctx: ClientContextLike): void {
  injectPageCss();
  ctx.effect(() => ctx.locale.register('settings.sensenova', { zh, en }), 'dsh-sensenova-freeapi: page copy');

  const legacy = adaptLegacyCredentials(ctx.connection?.api?.credentials);
  if (legacy !== undefined) {
    applyClientSurfaces(ctx, legacy);
    return;
  }
  ctx.inject(['remote.credentials'], (remoteCtx) => {
    applyClientSurfaces(remoteCtx, remoteCtx.remote.credentials);
  });
}
