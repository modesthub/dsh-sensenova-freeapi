## Why

SenseNova 模型目录已经由 host 从 `/models` 动态提供，设置页继续允许手动填写模型会形成第二个事实来源，并可能展示已不在最新目录中的选择。现在移除该入口，使 host 自动目录成为模型可见性与选择的唯一事实来源，减少配置歧义和过期模型风险。

## What Changes

- 移除 SenseNova 设置页中的手动加入模型和隐藏模型文本框及其说明。
- 移除或停止使用 `modelSelection.include` 与 `modelSelection.exclude` 配置；模型列表仅采用 host 自动获取并刷新后的目录及既有自动过滤规则。
- 对已有 `modelSelection` 配置不再提供兼容行为：其中的手动 include/exclude 将失效或被清理，用户自定义的模型覆盖不再影响模型目录。**BREAKING**
- 保持 SenseNova provider 的自动目录获取、目录元数据和不可路由模型过滤行为，不新增手动模型来源。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `sensenova-provider`：修改模型目录和 Web 设置页的用户可观察行为，使 host 自动目录成为唯一事实来源，并移除手动模型 include/exclude 覆盖及其配置兼容性。

## Impact

- 影响 SenseNova 设置页、`llm-sensenova` 配置中的 `modelSelection` 字段，以及模型目录生成路径。
- 现有依赖手动 include/exclude 的用户配置将不再生效（或在配置迁移/清理时被移除）；未出现在 host 最新目录中的模型不会因旧配置而出现。
- 不改变 provider 路由注册、凭据、账户轮换、请求协议或 host 目录接口本身；不引入新的外部依赖。
