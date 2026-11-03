/**
 * SenseNova 客户端插件入口（browser half）。
 *
 * 只做多账户连接配置所必需的事：
 *   1. 注册 `settings.sensenova` 文案命名空间（zh/en）；
 *   2. 桥接凭据面：优先宿主 `remote.credentials`，旧版退化为
 *      `connection.api.credentials`（与 @mars-sea/dsh-commandcode-provider 同构）；
 *   3. 用 `configForms.get('llm-sensenova')` 生成设置域，
 *      交给 SenseNovaSettingsController（领域层，无 JSX）；
 *   4. 注入 `settings.section`（设置页）、`settings.models.provider-card`
 *      （Models 页卡片）两个槽；v0.3.0 起另注入侧边栏大面板：
 *      `sidebar.panellist`（侧边栏入口）+ `main`（中央大面板，key=sensenova）。
 *
 * API key 一律经凭据域写入（credential-ref），页面不回显明文；host 是唯一事实
 * 来源，保存后立即热生效。
 */
import { SenseNovaPanel, SenseNovaPanelIcon } from './panel';
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
    /* 导入 / 导出 Key 区块（v0.2.1） */
    '.sn-titleRow{display:flex;align-items:center;justify-content:space-between;gap:12px}',
    '.sn-titleActions{display:flex;align-items:center;gap:8px}',
    '.sn-fieldActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.sn-btnDanger{font-size:12px;line-height:1.4;padding:3px 10px;border-radius:6px;border:1px solid var(--dsw-alias-status-danger,#d93026);background:transparent;color:var(--dsw-alias-status-danger,#d93026);cursor:pointer;white-space:nowrap}',
    '.sn-btnDanger:hover:not(:disabled){background:var(--dsw-alias-status-danger,#d93026);color:#fff}',
    '.sn-btnDanger:disabled{opacity:.5;cursor:not-allowed}',
    /* 账户列表折叠按钮（v0.2.7） */
    '.sn-accountsToggle{font-size:12px;padding:4px 10px;margin-bottom:4px;align-self:flex-start}',
    '.sn-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.sn-error{color:var(--dsw-alias-status-danger,#d93026)}',
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
    /* 调度面板（2026-11-01）：两个主旋钮 + 实时推算，边测边调时主要看这块 */
    '.sn-scheduling{gap:12px}',
    /* 分组编辑器（2026-11-02）：账户方块 + key 方块 + 组框，交互沿用 output/key-pool-ui-v7.html */
    '.sn-kp{display:flex;flex-direction:column;gap:16px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:10px;padding:12px 14px 14px;background:var(--dsw-alias-bg-layer-1,transparent);min-width:0}',
    '.sn-kpHead{display:flex;flex-direction:column;gap:3px;position:relative;padding-right:96px}',
    '.sn-kpHeadHint{margin:0}',
    '.sn-kpRow{display:flex;align-items:flex-end;gap:10px;min-width:0}',
    /* 账户方块：44×44 圆角 11，右上角挂组数徽标；整块可点开账户菜单 */
    '.sn-kpAcct{position:relative;flex:0 0 auto;width:44px;height:44px;margin-top:24px;padding:0;border-radius:11px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.32));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,#222);font:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .12s ease,background .12s ease}',
    '.sn-kpAcct:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#3b82f6)}',
    '.sn-kpAcct:disabled{opacity:.5;cursor:not-allowed}',
    '.sn-kpAcctNum{font-size:15px;font-weight:600;line-height:1}',
    '.sn-kpAcctCnt{position:absolute;top:-6px;right:-6px;min-width:15px;height:15px;padding:0 3px;border-radius:8px;background:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-label-primary-foreground,#fff);font-size:10px;line-height:15px;text-align:center;font-variant-numeric:tabular-nums}',
    '.sn-kpTrack{position:relative;display:flex;gap:6px;height:16px;padding:0 1px;flex:0 0 auto;margin-top:24px}',
    '.sn-kpSlot{width:16px;height:16px;border-radius:4px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));transition:background .16s ease,border-color .16s ease,box-shadow .16s ease}',
    // 组框只是"圈"，必须让点击穿透到下面的格子 —— 否则点 key 永远打不开面板。
    '.sn-kpBox{position:absolute;top:-3px;height:22px;border:1px solid var(--dsw-alias-brand-primary,#3b82f6);border-radius:8px;background:rgba(59,130,246,.08);pointer-events:none;transition:border-color .16s ease,background .16s ease,box-shadow .16s ease}',
    '.sn-kpBox[data-active="1"]{box-shadow:0 0 0 2px rgba(59,130,246,.22)}',
    '.sn-kpTag,.sn-kpGrip{pointer-events:auto}',
    '.sn-kpBox[data-over="1"]{border-color:var(--dsw-alias-label-warning,#d99614);border-style:dashed;background:rgba(217,150,20,.1)}',
    '.sn-kpTag{position:absolute;top:-16px;left:0;display:flex;align-items:center;gap:3px;font-size:10.5px;line-height:1;white-space:nowrap;color:var(--dsw-alias-label-secondary,#5c5c5c);cursor:context-menu;padding:1px 2px;border-radius:4px}',
    '.sn-kpTag:hover{color:var(--dsw-alias-brand-primary,#3b82f6)}',
    '.sn-kpTagText{font-variant-numeric:tabular-nums}',
    '.sn-kpWarn{color:var(--dsw-alias-label-warning,#d99614);border:1px solid currentColor;border-radius:3px;padding:0 2px;font-size:9px;line-height:1.3}',
    // 左右两个手柄：右边缘永远有，左边缘只在组前还有东西时出现（v7 同款）。
    '.sn-kpGrip{position:absolute;top:-3px;bottom:-3px;width:9px;cursor:ew-resize;background:transparent}',
    '.sn-kpGripR{right:-5px}',
    '.sn-kpGripL{left:-5px}',
    '.sn-kpGrip::after{content:"";position:absolute;top:6px;bottom:6px;width:3px;border-radius:2px;background:var(--dsw-alias-brand-primary,#3b82f6);opacity:.5;transition:opacity .12s ease,top .12s ease,bottom .12s ease}',
    '.sn-kpGripL::after{left:3px}',
    '.sn-kpGripR::after{right:3px}',
    '.sn-kpGrip:hover::after{opacity:1;top:2px;bottom:2px}',
    'body.sn-kpDragging{cursor:ew-resize;user-select:none}',
    'body.sn-kpDragging .sn-kpSlot,body.sn-kpDragging .sn-kpTag{pointer-events:none}',
    '.sn-kpHint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap;padding-bottom:1px}',
    '.sn-kpBtn{width:20px;height:20px;padding:0;border-radius:5px;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.45));background:transparent;color:var(--dsw-alias-label-secondary,#5c5c5c);font-size:13px;line-height:1;cursor:pointer;flex:0 0 auto;transition:border-color .12s ease,color .12s ease}',
    '.sn-kpBtn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-brand-primary,#3b82f6)}',
    '.sn-kpBtn:disabled{opacity:.45;cursor:not-allowed}',
    '.sn-kpPreview{margin:0;font-variant-numeric:tabular-nums;line-height:1.6}',
    /* 动效（对齐 v7）：绿=请求在飞，红=429 闪三次；重放靠组件先清空再下一帧加回 */
    // 选择器要压过后面的 [data-configured]/[data-orphan]/[data-selected]（同权重时后者赢，
    // 绿格会被灰底吃掉）；多一层 .sn-kp 提高特异性，且不依赖样式书写顺序。
    '.sn-kp .sn-kpSlot[data-flash="live"]{background:var(--dsw-alias-label-success,#22c55e);border-color:#4ade80;box-shadow:0 0 0 3px rgba(34,197,94,.35)}',
    '.sn-kp .sn-kpSlot[data-flash="429"]{animation:sn-kpFlash429 .3s ease-in-out 3}',
    '@keyframes sn-kpFlash429{0%,100%{background:var(--dsw-alias-label-error,#ef4444);border-color:#f87171;box-shadow:0 0 0 3px rgba(239,68,68,.35)}50%{background:rgba(127,127,127,.28);box-shadow:none}}',
    '.sn-kpAdd{margin-top:2px}',
    '.sn-kpDemo{position:absolute;right:0;top:0}',
    /* 演示进度条（2026-11-02）：蓝=播放中，红=两轮全败抛宿主 */
    '.sn-kpDemoHud{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;border:1px solid rgba(59,130,246,.32);background:rgba(59,130,246,.08);color:var(--dsw-alias-label-secondary,#5c5c5c);font-size:11.5px;line-height:1.5;font-variant-numeric:tabular-nums}',
    '.sn-kpDemoHud[data-state="thrown"]{border-color:rgba(239,68,68,.4);background:rgba(239,68,68,.09);color:var(--dsw-alias-label-error,#d9534f)}',
    '.sn-kpDemoDot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary,#3b82f6);animation:sn-kpDemoPulse 1s ease-in-out infinite}',
    '.sn-kpDemoHud[data-state="thrown"] .sn-kpDemoDot{background:var(--dsw-alias-label-error,#ef4444);animation:none}',
    '.sn-kpDemoText{flex:1 1 auto;min-width:0}',
    '.sn-kpDemoBar{flex:0 0 96px;height:4px;border-radius:2px;overflow:hidden;background:rgba(127,127,127,.18)}',
    '.sn-kpDemoBar > span{display:block;height:100%;background:var(--dsw-alias-brand-primary,#3b82f6);transition:width .1s linear}',
    '.sn-kpDemoHud[data-state="thrown"] .sn-kpDemoBar > span{background:var(--dsw-alias-label-error,#ef4444)}',
    '@keyframes sn-kpDemoPulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}',
    /* 正在请求的账户/组：只加高亮，不改变 .sn-kpBox 的 pointer-events:none */
    '.sn-kpBox[data-demo="1"]{border-color:var(--dsw-alias-brand-primary,#3b82f6);background:rgba(59,130,246,.16);box-shadow:0 0 0 2px rgba(59,130,246,.28)}',
    '.sn-kpAcct[data-demo="1"]{border-color:var(--dsw-alias-brand-primary,#3b82f6);background:rgba(59,130,246,.14);box-shadow:0 0 0 2px rgba(59,130,246,.2)}',
    /* 智能组间定时按钮 + 说明（2026-11-03） */
    '.sn-kpSmartGap{margin-right:auto}',
    '.sn-schedGapNote{margin:0;color:var(--dsw-alias-label-secondary,#5c5c5c);font-variant-numeric:tabular-nums}',
    /* 点格子后的编辑面板（2026-11-02）：贴在本区块底部，不跳页不弹窗 */
    '.sn-kpSlot[data-empty="1"]{background:transparent;border-style:dashed;border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.25))}',
    '.sn-kpSlot[data-configured="1"]{background:rgba(127,127,127,.28);border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.45))}',
    '.sn-kpSlot[data-unset="1"]{background:transparent;border-style:dashed;border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.25));cursor:pointer}',
    '.sn-kpSlot[data-orphan="1"]{background:rgba(217,150,20,.16);border:1px dashed var(--dsw-alias-label-warning,#d99614)}',
    '.sn-kpSlot[data-staged="1"]{background:transparent;border-style:dashed;border-color:var(--dsw-alias-label-error,#d9534f)}',
    '.sn-kpSlot[data-selected="1"]{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#3b82f6)}',
    '.sn-kpSlot{cursor:pointer}',
    '.sn-kpEditor{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;padding:10px 12px 12px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}',
    '.sn-kpEditorHead{display:flex;align-items:center;gap:8px}',
    '.sn-kpEditorTitle{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#222)}',
    '.sn-kpEditorNote{margin:0}',
    '.sn-kpBadge{font-size:11px;line-height:1.5;padding:1px 8px;border-radius:20px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
    '.sn-kpBadgeOk{color:var(--dsw-alias-label-success,#2f855a);border-color:currentColor;background:rgba(47,133,90,.08)}',
    '.sn-kpField{display:flex;flex-direction:column;gap:4px}',
    '.sn-kpLabel{font-size:12px;color:var(--dsw-alias-label-secondary,#5c5c5c)}',
    '.sn-kpEditorActions{display:flex;gap:8px;flex-wrap:wrap}',
    /* 组 / 账户菜单：fixed 浮层 + 全屏背板，点背板或 Esc 关闭 */
    '.sn-kpMenuBackdrop{position:fixed;inset:0;z-index:60;background:transparent}',
    '.sn-kpMenu{position:fixed;z-index:61;display:flex;flex-direction:column;gap:2px;padding:5px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 10px 28px rgba(0,0,0,.22)}',
    '.sn-kpMenuTitle{padding:4px 8px 6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}',
    '.sn-kpMenuItem{padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#222);font:inherit;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.sn-kpMenuItem:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12))}',
    '.sn-kpMenuItem:disabled{opacity:.4;cursor:not-allowed}',
    '.sn-kpMenuDanger{color:var(--dsw-alias-label-error,#d9534f)}',
    '.sn-kpMenuItemArmed{background:var(--dsw-alias-label-error,#d9534f);color:#fff}',
    '.sn-schedEstimate{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));font-variant-numeric:tabular-nums;line-height:1.6}',
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
    // v0.5 P0：运行日志「限流/全部」分段切换（纯 UI，不刷新不落盘）。
    // .sn-segmented 与 .sn-fieldHead 同排时 margin-left:auto 靠右；行内 gap 已由 .sn-fieldHead 提供。
    '.sn-segmented{margin-left:auto;display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));font-size:12px}',
    '.sn-segmented button{border:none;background:none;color:var(--dsw-alias-label-tertiary,#8a8a8a);padding:2px 10px;border-radius:6px;cursor:pointer;font:inherit;line-height:1.6}',
    '.sn-segmented button:hover:not(:disabled){color:var(--dsw-alias-label-primary,#222)}',
    '.sn-segmented button:disabled{opacity:.55;cursor:default}',
    '.sn-segmented .sn-segmentedActive{background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,#222);box-shadow:0 1px 2px rgba(0,0,0,.12);font-weight:600}',
    '.sn-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
    /* 视觉调用行的 code 列（2026-11-02）：拖图=紫、工具=蓝、纯文本=青，与主对话行区分 */
    '.sn-diagnosticsCode[data-vision="bridge"]{color:#a78bfa}',
    '.sn-diagnosticsCode[data-vision="tool"]{color:#60a5fa}',
    '.sn-diagnosticsCode[data-vision="chat"]{color:#22d3ee}',
    '.sn-diagnosticsVision{color:#a78bfa;font-weight:600}',
    '.sn-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
    '.sn-diagnosticsBody{display:flex;flex-direction:column;gap:10px;min-width:0}',
    '.sn-diagnosticsStats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}',
    '.sn-diagnosticsStat{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));min-width:0}',
    '.sn-diagnosticsValue{font-size:20px;font-weight:600;line-height:1.2;color:var(--dsw-alias-label-primary,#222)}',
    '.sn-diagnosticsList{display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:8px;overflow:hidden}',
    // 🔴 2026-09-27：三列 → 五列（时间 / 类型 / 模型 / 账户 / API）。账户名与 ref 名
    // 都可能较长 ⇒ 这两个单元格配 `.sn-truncate` 做省略号，避免把窄面板撑破。
    // 🔴 v0.5 P0：五列 → 七列（时间 / 类型 / 组 / 模型 / 耗时 / 账户 / API）。
    '.sn-diagnosticsRow{display:grid;grid-template-columns:58px 1fr 34px 1fr 52px 72px 1.1fr;gap:10px;align-items:center;padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);min-width:0}',
    '.sn-diagnosticsList>div+div>.sn-diagnosticsRowButton{border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16))}',
    '.sn-diagnosticsRowButton{width:100%;border:none;background:none;text-align:left;cursor:pointer;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#222)}',
    '.sn-diagnosticsRowButton:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07))}',
    // v0.5 P0：成功行（result=ok）用绿色标签色弱化，与限流行（橙/黄）形成对比 ——
    // 「限流/全部」模式里都靠它一眼区分成功与异常。
    '.sn-diagnosticsRowButton[data-result="ok"]{color:var(--dsw-alias-label-success,#2f7d4f)}',
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
    /* 侧边栏大面板（v0.3.0） */
    '.sn-sbIcon{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#5c5c5c)}',
    '.sn-sbIconActive{color:var(--dsw-alias-brand-primary,#3b82f6)}',
    /* main 大面板：铺满主列，可滚动，内容列宽约束 */
    '.sn-panel{height:100%;overflow-y:auto;overscroll-behavior:contain}',
    '.sn-panelBody{padding:24px 28px 40px;box-sizing:border-box;min-height:100%}',
    '.sn-panelInner{max-width:860px;margin:0 auto}',
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
    controller.scheduleCredentialsRefresh();
  }), 'dsh-sensenova-freeapi: credential invalidations');

  const injected = () => ({
    hooks: { sensenovaSettings: store },
    edit: (field: Parameters<SenseNovaSettingsController['edit']>[0], text: string) => controller.edit(field, text),
    save: () => void controller.save(),
    discard: () => controller.discard(),
    addAccount: () => controller.addAccount(),
    addAccountKey: (account: number, key: string) => controller.addAccountKey(account, key),
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
    setErrorLogMode: (mode: 'limits' | 'all') => controller.setErrorLogMode(mode),
    refreshModelInfo: () => void controller.refreshModelInfo(),
    editKeysIoText: (text: string) => controller.editKeysIoText(text),
    exportKeys: () => void controller.exportKeys(),
    importKeys: () => void controller.importKeys(),
    refreshCredentials: () => void controller.refreshCredentials(),
    clearAllAccounts: () => controller.clearAllAccounts(),
    setRetryMode: (mode: 'normal' | 'always') => controller.setRetryMode(mode),
    editRetry: (field: Parameters<SenseNovaSettingsController['editRetry']>[0], text: string) =>
      controller.editRetry(field, text),
    editPool: (field: Parameters<SenseNovaSettingsController['editPool']>[0], text: string) =>
      controller.editPool(field, text),
    // 调度策略（2026-11-01 固定间隔模式）
    setSchedMode: (mode: string) => controller.setSchedMode(mode),
    setSchedGrouping: (grouping: string) => controller.setSchedGrouping(grouping),
    // 分组编辑器（2026-11-02）：每账户切几组。整表替换，[] = 恢复缺省形状。
    setSchedGroups: (plan: Parameters<SenseNovaSettingsController['setSchedGroups']>[0]) =>
      controller.setSchedGroups(plan),
    // 智能分组（2026-11-02）：按 4 个一组重排。
    smartGroupAll: () => controller.smartGroupAll(),
    // 智能组间定时（2026-11-03）：按实际账户数推荐 groupGapMs。
    smartGroupGap: () => controller.smartGroupGap(),
    editSched: (field: Parameters<SenseNovaSettingsController['editSched']>[0], text: string) =>
      controller.editSched(field, text),
    // 视觉辅助（融合自 vision-aid）
    setVisionEnabled: (on: boolean) => controller.setVisionEnabled(on),
    setVisionBridgeMode: (mode: Parameters<SenseNovaSettingsController['setVisionBridgeMode']>[0]) =>
      controller.setVisionBridgeMode(mode),
    editVisionField: (field: Parameters<SenseNovaSettingsController['editVisionField']>[0], text: string) =>
      controller.editVisionField(field, text),
  });

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

  // v0.3.0：侧边栏大面板 —— `sidebar.panellist` 入口 + `main` 中央面板成对注册。
  // 复用同一份 injected props / SenseNovaSection，面板是唯一入口（设置页入口已移除）。
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'sensenova',
    order: 30,
    label: () => ctx.locale.bind('settings.sensenova')('nav'),
    locale: 'settings.sensenova',
  }, SenseNovaPanelIcon) as () => void);

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'sensenova',
    locale: 'settings.sensenova',
    inject: injected,
  }, SenseNovaPanel) as () => void);
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
