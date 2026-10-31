/**
 * SenseNova 侧边栏大面板（v0.3.0 特性）：
 *  - `sidebar.panellist` 侧边栏入口（图标，ownerProps: { size, active }）
 *  - `main` keyed 中央大面板（复用 `SenseNovaSection` 全部内容）
 *
 * 大面板与设置页共用同一个 `SenseNovaSection` 组件，避免双份 UI 漂移；
 * 面板外层只负责滚动容器与内容列宽（main 列比设置页更宽）。
 */
import { SenseNovaSection, type SenseNovaSectionProps } from './section';

/** 宿主 sidebar.panellist 注入给图标组件的 ownerProps。 */
export interface SenseNovaSidebarIconProps {
  /** 请求的方形边长（像素）。 */
  size: number;
  /** 该面板当前是否在主列选中。 */
  active: boolean;
}

/**
 * 侧边栏图标：钥匙（key 池管理）。active 时用品牌色高亮。
 */
export function SenseNovaPanelIcon({ size, active }: SenseNovaSidebarIconProps): JSX.Element {
  return (
    <span
      className={active ? 'sn-sbIcon sn-sbIconActive' : 'sn-sbIcon'}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8.2" cy="8.2" r="4.4" />
        <path d="M11.4 11.4 20.5 20.5" />
        <path d="M15.6 15.6l2.6-2.6" />
        <path d="M18.2 18.2l1.7-1.7" />
      </svg>
    </span>
  );
}

/**
 * main 大面板：设置区内容 + 滚动容器 + 内容列宽约束。
 *
 * `main` keyed slot 的组件与 `settings.section` 的组件接收同一份注入 props
 * （injected hooks 派生出的 useSensenovaSettings 与方法回调），所以直接透传。
 */
export function SenseNovaPanel(props: SenseNovaSectionProps): JSX.Element {
  return (
    <div className="sn-panel">
      <div className="sn-panelBody">
        <div className="sn-panelInner">
          <SenseNovaSection {...props} />
        </div>
      </div>
    </div>
  );
}