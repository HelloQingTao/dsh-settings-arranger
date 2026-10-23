# dsh-settings-arranger 需求设计文档

## 一、背景与问题

dsh Web GUI 的设置对话框左侧有一列分区导航（通用、外观、模型、会话日志、插件、shell、agent loop、subagent、web 搜索、以及各插件注册的分区如 QoL、侧卡、故障转移……）。

随着安装的插件增多，导航条目越来越长，但存在两个硬伤：

1. **顺序不可改**：导航顺序由各插件注册 `settings.section` slot 时自带的 `order` 数字决定，壳层（`@deepseek-ai/dsh-client-ui-settings-general`）按 `a.order - b.order` 排序后渲染，顺序在注册时写死，没有任何公开的运行时改序接口。
2. **没有分组**：十几个条目平铺一列，官方与插件的分区混在一起，找某个设置页要来回扫。

调研结论（2026-10-15）：本机已装插件（dsh-qol、dsh-better-sidebar、dsh-failover-queue 等）都只是"往设置页注册自己的分区/行/标签页"，**没有任何插件能对导航整体重排或分组**；插槽体系也没有提供"重排/分组已有页面"的扩展点。因此需要独立开发本插件。

## 二、目标

对设置对话框左侧分区导航实现：

1. **拖拽排序**：任意分区条目可拖到任意位置。
2. **分组**：条目可归入若干组，组头可折叠；支持新建/重命名/删除组。
3. **持久化**：排布按浏览器保存，刷新后保持。

非目标（明确不做）：

- 不改各分区页面的内容本身，只动导航的顺序与视觉分组。
- 不改分区页面内的行/标签页（如 General 内的偏好行、Plugins 内的标签页）。
- 不改 `settings.section` slot 的 `only` 过滤逻辑（分区 key 始终保留，切换逻辑不受影响）。

## 三、技术路线

### 现状机制（已核实本机代码）

- 导航列表：`dsh-client-ui-settings-general/lib/client.js` 中壳层从 `ctx.slots.entries("settings.section")` 取条目（id/order/label），`.sort((a,b)=>a.order-b.order)` 后交给导航组件渲染；内容列按激活分区 key 用 `renderSlot("settings.section", …, { only: active })` 渲染。
- slot 注册契约（`dsh-client-ui-settings` 的 slots.d.ts）：`settings.section` 为 list 型，注册项必填 `id`，可选 `order`、`label`。
- 参考先例：dsh-qol 的 settings-mobile / settings-remember-tab 直接在设置对话框 DOM 上做结构锚定与行为增强，已验证该模式在本机可行。

### 路线选择：DOM 操作（client-only 插件）

由于宿主没有暴露重排接口，本插件采用纯 client 插件（`dsh.client.platform: "web"`），在设置对话框打开后对其导航 DOM 做增强：

- **锚定**：用结构性选择器定位设置对话框的导航容器（不依赖脆弱的位置路径；找不到目标时静默跳过并 `console.warn`，绝不动页面其他部分）。参考 dsh-qol 的做法：结构锚定 `:has(> nav)` 之类只匹配设置对话框的选择器。
- **重排**：按持久化的顺序对导航条目 DOM 节点重排（`appendChild` 按序移动）。
- **分组**：在导航列表中插入自绘的分组头节点（可折叠），把条目节点移入组内；条目本身的 DOM 结构与事件（点击切换分区）不改动。
- **拖拽**：HTML5 drag & drop（dragstart/dragover/drop），把手仅在 hover 出现。参考 dsh-qol 的踩坑教训：**触摸设备上要禁用原生 dragstart**（Chromium 触摸拖拽易卡死整页），鼠标/触控板不受影响。
- **兜底**：无持久化数据时 UI 零改动；插件卸载/禁用后导航立即恢复原生顺序（所有改动都在运行时 DOM 层，不写宿主状态）。

### 持久化

- localStorage，key：`dsh.settings-arranger.v1`
- 结构：`{ groups: [{ id, label, sectionIds: string[] }], collapsed: string[] }`
- 未收录进任何组的分区条目按原生 order 落在"其他"区（或保持原位，实现时取体验更好者）。
- 按 dsh-qol 同款模式按浏览器保存（不跨设备同步）。

## 四、交互设计（用户已确认，2026-10-15）

**入口位置（用户拍板）**：设置界面右上角，"打开配置文件"按钮左侧新增一个入口——"整理导航"按钮。该按钮通过 `settings.action` list slot 注册（与官方 `open-document` 动作同一插槽，order 放它前面），是宿主原生支持的扩展点，无需 DOM 注入。

**编辑模式（显式编辑开关）**：

| 场景 | 行为 |
|---|---|
| 普通模式 | 导航按用户自定义顺序+分组显示，条目不可拖，防误触 |
| 点"整理导航"按钮 | 进入编辑态：条目与组头出现拖拽把手；组头右侧出现 ✎ 重命名 / ✕ 删组（组内条目散回"其他"）；底部出现「＋ 新建分组」与「恢复默认」；按钮变为"完成" |
| 拖拽条目 | 松手即落入新位置（组内排序 / 跨组移动），即时写 localStorage |
| 组头点击 | 折叠 / 展开该组（普通模式下也生效） |
| 退出编辑 | 点"完成"、按 Esc 或点击对话框外部；退出即定型，无单独保存按钮 |
| 恢复默认 | 编辑态文字按钮，confirm 后清空自定义排布，回到原生顺序 |

即时生效，无需刷新。

设计理由：不新增设置 tab——这是"改设置页布局"的插件，配置就放在被整理的导航上就地完成，所见即所得；tab 表单无法直观表达拖拽排序。

## 五、插件结构

按既定 dsh 插件开发模式（参照 dsh-qol / dsh-model-fallback-queue）：

```
dsh-settings-arranger/
├── docs/design-plan.md   ← 本文档
├── package.json          ← dsh.client: { platform: "web", inject: [...] }
├── cordis.patch.yml      ← Loader 挂载行
├── lib/
│   ├── index.js          ← host 半（如需；最小可为空壳）
│   └── client.js         ← client 半：settings.action 注册、导航 DOM 锚定、重排、分组、拖拽、持久化
└── README.md
```

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| DSH 升级改设置对话框 DOM 结构 | 结构性选择器 + 全程容错（找不到即静默跳过）；排布数据按分区 id 存，与 DOM 结构解耦 |
| 新插件注册了导航里没有的分区 id | 数据里多余的 sectionIds 忽略；未收录条目有兜底归属 |
| 触摸设备拖拽卡死 | 触摸期间禁用 dragstart（qol 已验证的做法） |
| 与 dsh-qol settings-mobile 的移动端全屏设置页冲突 | 移动端断点下同样适用（操作目标是导航列表本身）；上线前在窄屏实测 |

## 七、验收标准

1. 安装启用后，设置导航出现拖拽把手与分组头；拖拽排序即时生效且刷新后保持。
2. 新建/重命名/删除组、折叠组均即时生效并持久化。
3. "恢复默认"后导航与原生完全一致。
4. 禁用/卸载插件后设置页零残留。
5. 触屏设备上拖拽不引发页面卡死（dragstart 已禁）。
6. 窄屏（≤768px）下与 dsh-qol settings-mobile 共存无视觉破损。

## 八、迭代记录

### 2026-10-16：分组泄漏修复 + 拖拽能力补齐（用户实测反馈 4 项）

用户反馈原话：

> 分组中的某个条目点击后，分组外面就自动显示了这个条目，且点击其他条目这个出现的条目不会自动隐藏；
> 分组本身也要可以拖动排序；
> 目前分组内的不可以再排序，当整理排序时，分组内的条目可以拖动排序，可以拖动到其他分组或拖出分组；
> 另外，分组和其他的正常条目要分开放，更显眼。

1. **条目泄漏（根因）**：可见性是绑在宿主行自身的 class 上（`.dsa-collapsed-hide`）。宿主 React 每次切换分区都会重写行节点的 className，class 被抹掉后行就"跑"到分组外，且之后点谁都不会再隐藏它。现改为插件自己的属性 `[data-dsa-hidden]` 控制可见性（CSS 优先于宿主 class），并让 MutationObserver 同时监听宿主行的 `class / aria-current / data-modal-autofocus` 变化，一旦被重写就立即重打标记（`syncFlags()`，幂等写入，不会自激）。
2. **分组排序**：编辑态组头可拖拽重排；也可把组拖到普通条目上（落到该条目所属组的相邻位置，未分组则排到所有分组之后）。
3. **组内/跨组拖条目**：`move()` 重写为"先按 id 解析容器、再删除、再按目标下标插入"，修掉原先同容器内删除导致的下标漂移；支持组内排序、跨组、拖出到"其他"区、以及从"其他"区拖回组内（对账时会把已归属组的 id 从 `__misc__` 里剔除，避免同一行被列两次）。
4. **分组与普通条目分隔**：组头有品牌色内嵌竖条 + 上间距；第 2 个及之后的组头、以及"其他"分隔头都带 `border-top` 分隔线。

### 2026-10-16：清理分组数据时验证"恢复默认"链路，顺手修掉 3 处

1. **编辑态底栏重复堆叠**：`apply()` 靠 `[data-dsa-own="1"]` 清掉自绘节点，但 `buildFooter()` 造出的 `.dsa-nav-footer` 没打这个标记，于是编辑态每渲染一次就多堆一个底栏（实测出现 2 个"＋ 新建分组 / 恢复默认"）。已补 `footer.setAttribute('data-dsa-own','1')`。**规则：插件注入的任何节点都必须带 `data-dsa-own="1"`。**
2. **恢复默认的确认按钮文案错**：`askConfirm({danger:true})` 一律显示"删除"，清空分组时按钮却写着"删除"，容易误解。`askConfirm` 新增可选 `confirmLabel`，恢复默认传 `t('reset')`，现在显示"取消 / 恢复默认"。
3. **清空后仍出现"其他"分组头**：`layout` 只要存在未归属行就插入"其他"标签，编辑态下即便一个分组都没有也会给整列加个"其他"标题。已改为 `if (rest.length && hasData)`，无分组时不显示。
4. 复核：清空后 localStorage 为 null、0 个分组头、0 个隐藏行；再点"完成"退出编辑态后 `dsa-nav-list` 类被摘掉、22 行 order 全清、0 个可拖拽节点，导航与原生完全一致。

### 2026-10-16：第三批实测反馈（v0.4：块序列模型）

用户原话：
> 1. 分组不能拖动到单个条目下面，例如我想让第一个分组放在全局指令下面
> 2. 分组3插件样式展开后，所有内容出现，和下面的全局指令条目混在一起，看不出来分组3的最后一个条目是啥，应该加一个分割条（分组最后一个item后面）
> 3. 分组左侧颜色条默认取当前主题颜色、强调色

实现：

1. **布局模型升级为顶层块序列**：groups 只管成员归属，`state.order` 是扁平的顶层块序列（`{kind:'group'|'row', id}`），组块与单个未分组行块可任意交错 → 分组可以落到任意普通条目的上/下/导航末尾，且顺序随拖拽持久化。旧数据自动迁移（normalizeState / orderFrom 负责迁移、剪枝与补齐）。**根因 bug：`loadState()` 此前不会透传新加的 `order` 字段，每次拖拽都以 `loadState()` 重读状态，布局被重置成"分组在前 + 行按原生序"，交错立刻失效。**
2. **组尾分隔条**：某分组最后一个可见元素之后如果跟的是普通行（或导航末尾），给它加 `data-dsa-end="1"`（border-bottom + padding-bottom）；若下一个块也是分组则不加（下一个组头自带 data-dsa-sep 上分隔线）。同时移除旧的"其他"伪分组头。
3. **强调色**：shell 的 `--dsw-alias-brand-primary-new-colorprimary-new-color` 硬编码（#4176e6 / --dsw-static-deepseek-450），换主题/皮肤不变；主题真正驱动的是 `--dsw-alias-brand-primary`（dream-skin 会覆盖它）。插件在 `.dsa-nav-list` 上定义 `--dsa-accent`（= brand-primary → onboarding-accent → currentColor），分组竖条、拖拽落点线、子菜单选中项统一走它；portal 到 body 的子菜单显式带上解析值。

验证（真实 GUI + 合成/真实拖拽）：分组落到普通行上方/下方/末尾且顺序持久化（刷新后保持）、分组之间拖拽排序、条目拖出分组并落在指定位置、编辑态组尾分隔条与缩进、强调色=皮肤紫 #a78bfa、普通模式子菜单点条目不泄漏（18/22 可见）、恢复默认清空后退出编辑态导航完全原生、console 无来自本插件的报错。

### 2026-10-16：第四批实测反馈（市场更新插件后，组内条目浮到组外）

用户原话：
> 在插件市场更新插件后，那个插件（已经在分组里面）会自动出现在分组外面，只有刷新页面才会复原，当设置页有变动能不能检测到？如何修复？

根因（用调试句柄 window.__dsaArranger 定位，双重）：

1. 宿主在插件更新后会**重新挂载**受影响插件的导航行（新 DOM 节点，天然没有我们的 `data-dsa-id`），而 `tagRows()` 只在首次锚定时跑；新行不被识别 → 不加隐藏/排序/成员标记 → 视觉上浮到分组外。刷新（重新锚定 + 打标）就复原。
2. 修了上条之后模拟重挂仍失败：**`syncFlags()` 里的 `normalizeState(this.state, nativeRows)` 在宿主提交中途运行**（旧行已移除、新行未打标），此刻 `nativeRows()` 暂缺该行，归一化就把成员从组的 `sectionIds` 里剔除（内存态）→ 行被当作新出现的未分组行追加到末尾。教训：把"行暂时缺席"误当"分区消失"。

修复：

- `apply()` 每次渲染前先 `tagRows()`（幂等，只补缺失的 id）→ React 新挂载的行会被立即识别并套用隐藏/排序/成员归属。
- `syncFlags()` 只依据内存态重打属性，绝不再重新归一化。
- `normalizeState()` 不再因"行未出现在当前 DOM"削减成员归属（仅去重）；行缺席时在渲染端跳过该 id（orderFrom 只为存在的 id 生成块）——插件更新期间的短暂缺席不丢组成员。
- 加了 `window.__dsaArranger` 调试句柄，方便从 console 驱动/检查（长期保留）。

检测能力（回答"能不能检测到"）：插件一直挂有 MutationObserver——导航行的增删、宿主对行 class/aria-current 的改写都会触发重算；本次是"识别"环节缺一环，补上后无需刷新页面。

验证（playwright 真实 GUI）：

- 模拟宿主重挂行（fresh 节点 replaceWith 旧行）→ 500ms 内被重新识别：仍在原分组（order 同槽位）、`data-dsa-hidden=1`、`display:none`，不浮出 ✓
- 回归：拖出分组/拖回分组、普通模式子菜单点条目不泄漏、console 无本插件报错 ✓

### 2026-10-16：第四批反馈 — 插件市场更新后组内条目露出组外

用户原话：
> 在插件市场更新插件后，那个插件（已经在分组里面）会自动出现在分组外面，只有刷新页面才会复原，当设置页有变动能不能检测到？

**结论：能检测到，缺的是"宿主提交稳定之后再补一次"。** 导航列表本来就有 MutationObserver，apply() 每次也都会重打标；但宿主在插件更新时会重挂载 section，行节点是**晚一拍**才出现在列表里的。我们的 80ms debounce 只要落在宿主 commit 的中间态，新行当时还不存在，打标/隐藏/排序全部落空；之后没有新的 childList 变更，就不会有第二次 render，于是那行一直停在原生位置，直到刷新重新锚定。

修复（三处，全部幂等）：

1. **`tagRows()` 不再假设行是直接子节点**：改为 `list.querySelectorAll('button')` 兜底（合并去重后按 DOM 序打标），宿主重挂载多套一层 wrapper 也能识别。
2. **`nativeRows()` 兜底**：直接子节点里一个 BUTTON 都没有时，回退到 scoped query。
3. **渲染后二次核对**：`render()` 结束后 50ms 检查 `hasUntagged()`（仍存在未打标的行 = 宿主还在 commit），有则走 `settle(pass)` 再渲染，最多 3 跳；observer 的 debounce 也改为走 `settle(0)`。`hasUntagged()` 会跳过 `[data-dsa-own]` 子树里的按钮（组头 ✎/✕、底栏按钮本来就不该有行身份），否则每次编辑态渲染都会触发一轮补渲染。

性能：稳态下 0 新增定时器（`hasUntagged()` 是一次查询，通常立刻返回 false）；只有宿主真在重挂载时多 1~2 次 render（每次 O(行数)，约 20 节点）；`settle` 有 3 跳上限，不会自激。

验证：克隆一行并抹掉 `data-dsa-id` 模拟宿主重挂载 → 50~180ms 内自动补标、隐藏与 order 全部到位；普通模式 16/20 可见、编辑态 20 行可拖 + 组头 2 + 组尾分割 1、恢复默认与退出编辑态均正常；console 无本插件报错。

### 2026-10-17：第五批实测反馈（恢复默认 / 下拉图标 / 弹框按钮间距）

用户原话：「整理导航点击后，最下面出现一个恢复默认布局的按钮（点击需要二次弹框确认）；分组点击后，下拉菜单需要显示其原有的item图标；添加分组的输入框下面，按钮仅仅贴着，需要修复」

1. **恢复默认按钮**：现状已满足（`buildFooter()` 只在编辑态挂到 navList 末尾、`order=10000`，`resetBtn` 走 `MODAL.askConfirm` 二次确认后才 `clearState()`）。新增 `[data-variant="danger"]` 的 hairline 上边线 + 4px 额外间距，避免它和「＋ 新建分组」挤在一起被误点。
2. **下拉菜单图标**：`toggleSubmenu()` 从行元素上克隆 `:scope > svg, :scope > img` 到 `.dsa-submenu-icon`（16×16，`flex:none`），标签移到 `.dsa-submenu-label`（`flex:1` + 省略号）。`data-active="0"` 的条目用透明圆点占位，保证有无图标时文字左缘对齐。
3. **弹框按钮贴着输入框**：`P.Modal` 不会给子节点额外间距，输入框与操作行之间原本是 0。操作行加 `marginTop: 20px`（实测由 0 → 20px）。
4. 顺手修掉 `onClose`/取消按钮里对 `st.kind` 的读取——`st` 为 null 时（关闭后回调）会抛 `Cannot read properties of null`。抽成 `dismiss()`，统一 `close(st && st.kind === 'confirm' ? false : null)`。

### 2026-10-17：子菜单选中态缩进对齐

用户反馈：「分组点击后，下拉中选中的左侧会缩进更少一点，以这个为准，其他没选中的条目缩进保持一致」。

根因：选中标记原本用 `[data-active="1"]::before` 生成，未选中行没有这个 4px 伪元素，于是未选中行整体右移 4px。改为**每个条目都带一个固定的 `.dsa-submenu-dot`（4px×4px 圆形占位）**，未选中为透明、选中为强调色——宽度恒定，标签左缘三者完全对齐（实测 labelLeft 全为 99px）。

### 2026-10-17：编辑态改为「全部内联展开 + 组头可折叠」

用户反馈：「点击整理导航时，分组内的所有内容都出现了，然后点击分组还出现了下拉菜单」，并给了两个方向（下拉内拖拽 / 全部展开点组头收起）。选择「全部展开」方向：

- **编辑态**：组内条目全部内联显示（`hidden` 集合只在非编辑态填充），组头点击 = 折叠/展开，**永不打开下拉**（`toggleSubmenu` 一开始就 `if (this.editing) return`）。
- **折叠 ≠ 隐藏**（关键）：折叠态只给成员行打 `data-dsa-collapsed-member="1"` 并 `opacity:.45`，**不移除**。否则行不是 drop target，既拖不出也拖不进——拖拽能力必须优先于「看起来收起了」。
- **普通态**不变：组内条目隐藏，点组头弹下拉。
- 三角箭头：`.dsa-editing .dsa-group-head .dsa-caret{rotate 0}`（展开）/ `[data-collapsed="1"]` 时 `-90deg`（收起）。
- 验证：编辑态 3/3 成员可见且 `draggable=true`；点组头后 `collapsed:["g1"]`、成员 opacity 0.45、无下拉；再点恢复 opacity 1；普通态下拉与隐藏不受影响。

### 2026-10-17：收起 = 真的不显示（覆盖上一条「只变灰」）

用户反馈：「整理导航点击后，点击分组，下面的元素只是全部变灰，我需要全部不显示，效果等于分组收起状态」。

上一条实现选的是「折叠只变淡、不移除」，理由是隐藏后行不再是 drag drop 目标。用户明确否掉了这个取舍——收起就要真的收起。改为：

- 可见性规则统一为 `if (!editing || collapsed.includes(g.id)) hidden.add(id)`（`apply()` 与 `syncFlags()` 两处都改，保持宿主 commit 中途也一致）。
- 删掉 `.dsa-editing [data-dsa-collapsed-member="1"]{opacity:.45}` 和对应的 `data-dsa-collapsed-member` 标记。
- 代价（已知并接受）：收起状态下组内行不存在，无法作为 drop target——要往里拖或往外拖，先点组头展开。

### 2026-10-17：npm 版装上不生效（client.js 的 Loader id 与包名不一致）

用户反馈：别人安装 npm 上的 `dsh-settings-arranger` 后启动异常/插件不激活，排查发现 npm 包里的 `client.js` 写的是 `id: '@local/dsh-settings-arranger'`。

根因（dsh 0.2.0-rc.2 实测）：

- 宿主 `dsh-client-modules` 为每个声明 `dsh.client` 的包生成一行，行 id = **package.json 的 `name`**，并用 `<name>/client` 这个 specifier 去 `import`；浏览器端 `ClientModuleSystem.register()` 用 `registration.id`（即 `client.js` 里 `__ModuleLoader__.load({id})` 的值）作 key，`materialize('dsh-settings-arranger')` 查不到 `'@local/dsh-settings-arranger'` 这个 key → `client-modules: no registered factory for "dsh-settings-arranger"`。宿主侧 `inactiveEntries()` 会报 `dsh-settings-arranger (dsh-settings-arranger): failed to import`，属于启动失败（不是可选警告）。
- 本地开发一直没暴露，是因为 `cordis.patch.yml` 里的 `name:` 当时也写成 `@local/...`，宿主按那个名字去找包，恰好对得上；改成正名后两边就对不齐了。
- 这个 `@local/` 前缀来自 dsh 内置脚手架模板（`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/`），模板假定包名也是 `@local/xxx`。**发布到 npm 的插件必须把 `package.json.name`、`cordis.patch.yml` 的 `name:`、`client.js` 的 `id` 三处统一成 npm 包名。**

修复：`client.js` 的 `id` 改为 `dsh-settings-arranger`，并在该行上方留注释说明该规则。校验方法（不必重启宿主）：`curl <实例>/plugins/??<pkg>/client.js&rev=…` 或直接 `grep "__ModuleLoader__.load" -A1 node_modules/<pkg>/client.js`，`id` 必须等于包名。

### 2026-10-23：Windows 缩放下组头主题色条中间断开（inset box-shadow → border-left）

用户报告（附 Windows 截图）：「win下，每个分组左侧的主题色条，从第二条开始，不是圆润的，中间有个黑色缺口，mac下是正常的」。

取证与根因：

- 断开的恰好全是带 `data-dsa-sep`（即同时有 `border-top` 发丝线）的组头；首组（无任何 border）永远完整。缺口 ≈16px，位置居中，两端圆弧完好。
- macOS Chromium 复现不出（DPR 整数）；在真实页面上用 CSS `zoom` 扫描分数化缩放，1.05/1.1/1.15/1.2/1.3 全部复现同症状，1.0/1.25/1.4/1.5 正常——与 Windows 用户常见的 110%/125%/130% 显示缩放吻合。
- 逐项开关实验定位触发条件：**元素同时具有 `inset box-shadow` + 任意 `border` + `border-radius` 时，Chromium 在分数化光栅缩放下会丢弃阴影的直边段**（只剩四角圆弧）。极简复现页不含 border 时不断，加 border 即断。

修复：主题色条从 `box-shadow:inset 3px 0 0 0` 改为 **`border-left:3px solid var(--dsa-accent,…)`**——边框在任何缩放下都走稳定的渲染路径。左内边距 12px→9px 补偿 3px 边框占位，内容列位置逐像素不变；编辑态头同理（`4px 12px`→`4px 12px 4px 9px`）。拖拽落点线规则里原来为了「顶掉 box-shadow 时保住色条」而重复断言的 `inset 3px` 段随之删除，只留 `0 ∓2px` 线（色条已由 border 常驻）。

验证（macOS Chromium + dsh web 真实页面）：

- 修复前坏分数 1.05/1.1/1.15/1.2/1.3：修复后 4 段主题条全部连续（此前各断成 ~13px+~11px 两段）。
- zoom 1.0：分段位置与修复前逐像素一致（无外观回归）。
- 编辑态组头色条连续、落点线计算样式为 `rgb(…N) 0px 2px 0px 0px` 且肉眼可见；普通态浅色/深色主题截图复核均连续。
