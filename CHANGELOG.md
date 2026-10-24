# 更新日志

本文件记录 dsh-settings-arranger 的对外发布内容，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

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
