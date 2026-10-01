/**
 * SenseNova 的 Models 页 provider 卡片（settings.models.provider-card slot）。
 *
 * 只读状态卡片：显示「已配置/未配置」徽标、活动路由标记、已配置账户数与活动
 * 账户，并引导用户前往「设置 → SenseNova」完成配置。不内嵌密钥输入框——密钥
 * 写入一律在设置页经凭据域完成，避免在 Models 页出现第二个写入口。
 */
import type { SettingsState, TranslateFn } from './settings';

export interface SenseNovaCardProps {
  t: TranslateFn;
  /** slots 框架注入的 uSES hook（由 injected.hooks.sensenovaSettings 派生）。 */
  useSensenovaSettings: <S>(selector: (snapshot: SettingsState) => S) => S;
  /** Models 页 owner props（参考实现的 provider.active / keyConfigured）。 */
  provider?: { active?: boolean };
  keyConfigured?: boolean;
}

export function SenseNovaProviderCard(props: SenseNovaCardProps): JSX.Element {
  const { t } = props;
  const state = props.useSensenovaSettings !== undefined
    ? props.useSensenovaSettings((snapshot) => snapshot)
    : undefined;

  const configuredAccounts = state?.accounts.filter((a) => a.configured).length ?? 0;
  const configured = state !== undefined && state.available
    ? (state.defaultConfigured || configuredAccounts > 0)
    : (props.keyConfigured ?? false);
  const active = props.provider?.active ?? false;
  const showBody = state !== undefined && state.available;

  return (
    <div className="sn-providerCard" data-sn-models-card="true">
      <div className="sn-field">
        <div className="sn-fieldHead">
          <span className="sn-label">{t('cardTitle')}</span>
          <span className="sn-badges">
            <span className={configured ? 'sn-badge' : 'sn-badgeMuted'}>
              {configured ? t('apiKeySet') : t('apiKeyUnset')}
            </span>
            {active ? <span className="sn-badge">{t('cardRouteActive')}</span> : null}
          </span>
        </div>
        {!showBody ? (
          <p className="sn-hint">
            {state === undefined ? t('cardRegistrationHint') : t('cardLoadingHint')}
          </p>
        ) : configured ? (
          <p className="sn-hint">{t('cardConfiguredHint')}</p>
        ) : (
          <p className="sn-hint">{t('cardUnconfiguredHint')}</p>
        )}
      </div>
      {showBody ? (
        <p className="sn-hint">
          {t('cardAccounts')}: {state.accounts.length}
          {state.activeAccount !== '' ? ` · ${t('cardActiveAccount')}: ${state.activeAccount}` : ''}
        </p>
      ) : null}
    </div>
  );
}
