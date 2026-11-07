# 更新日志

本文件记录 dsh-settings-arranger 的对外发布内容，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.7] - 2026-11-07

### 修复

- **拖动更顺** — 整理导航时拖动分区行不再发黏、卡顿，插入位置提示跟随更稳定。
- **重绘不打断整理** — 整理过程中设置页被重新渲染时，插入位置提示仍会显示，分组与顺序也会自动恢复，不会停留在错乱的排布上。

### English

### Fixed

- **Smoother arrange-mode dragging** — dragging section rows in arrange mode no longer stutters; the insertion marker tracks the pointer reliably.
- **Unaffected by page redraws** — if the settings page is re-rendered mid-drag, the insertion marker stays visible and groups/order re-sync automatically instead of staying stale.

## [0.1.6] - 2026-11-05

### 修复

- **兼容 DSH 新版设置导航** — 设置分区图标通过内联 slot 渲染（图标 `<span>` 里再套一层 `<span>`），插件原本用 `span:last-child` 取行标识，会误命中这层空图标 span，导致每一行的标识都变成空字符串：分组全部失效、编辑模式下无法拖拽/改名。现在改为只从按钮的直接子 span 中取带文字的标签，扁平图标结构同样适用。
- 顺带修复已被旧逻辑写入空标识的行：重新打开设置时会自动恢复正确标识，无需手动重置。

### English

### Fixed

- **newer DSH settings nav compatibility** — the settings nav now renders its section icons through an inline slot, which nests an extra `<span>` inside the icon. The old `span:last-child` identity probe matched that empty icon wrapper on every row instead of the label, so all row ids collapsed to `""`: groups were pruned and edit mode could not drag or rename anything. Identity now comes from the last *direct-child* `<span>` that actually has text; the older flat-svg markup keeps working.
- Rows already stamped with an empty id by the old logic are healed on the next dialog open — no manual reset needed.

## [0.1.5] - 2026-10-24

### 新增

- **跨端共享** — 导航排布保存为一份全局配置文件（~/.dsh/settings-arranger.json），网页版与桌面版共用：一处整理，另一端打开设置即生效。
- **自动迁移** — 旧版本存在浏览器里的排布会在首次加载时自动迁入配置文件，无需手动操作。
- **打开即最新** — 每次打开设置都读取最新排布，其他窗口或其他端的修改即时可见，无需刷新页面。
- **存储兜底** — 配置文件不可用时自动回退浏览器本地存储，行为与旧版一致，排布不丢失。

### 修复

- 分组名称不再来回闪烁，面板不再显示过期顺序。

### English

### Added

- **Cross-profile sync** — the nav layout is now saved as one global config file (`~/.dsh/settings-arranger.json`), shared by the web and desktop profiles: arrange it once, and it shows up on the other side the next time settings open.
- **Automatic migration** — layouts previously stored in the browser are migrated to the config file on first load. No manual steps.
- **Fresh on every open** — opening settings always picks up the latest layout, including changes made in another window or profile, without reloading the page.
- **Storage fallback** — if the config file is unavailable, the plugin falls back to browser storage and behaves exactly as before.

### Fixed

- Group labels no longer flicker between old and new names, and the panel no longer shows an outdated order after a client update.
