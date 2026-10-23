// dsh-settings-arranger — client half.
// Rearranges and groups the Settings dialog's left nav (settings.section rows)
// via DOM enhancement. Entry button registers through the `settings.action`
// slot (native extension point, renders left of the official open-document
// button). Layout persists in localStorage.
//
// Interaction model:
// - Normal mode: each group renders as ONE native-styled nav row; clicking it
//   opens a themed dropdown submenu listing its member rows. Member rows are
//   hidden inline. Rename/delete affordances only exist in edit mode.
// - Edit mode: groups expand inline, rows show drag affordances, footer offers
//   new-group / reset. Group heads drag-reorder; rows drag across groups.
//
// Loader id MUST equal package.json's `name`: the runtime keys its module table
// by registration.id, but the host graph row is keyed by package name and
// imports `<package name>/client`. Any mismatch (e.g. the scaffold's `@local/…`
// prefix) makes the row unresolvable and the plugin never activates.
window.__ModuleLoader__.load({
  id: 'dsh-settings-arranger',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    const STORAGE_KEY = 'dsh.settings-arranger.v1';
    const MISC_LABEL = { zh: '其他', en: 'Other' };

    // ---- persisted state -------------------------------------------------
    function loadState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.groups)) return null;
        // `order` must survive the round-trip: it IS the top-level block
        // sequence. Dropping it here made every move() rebuild the layout as
        // "groups first, rows in native order", silently discarding any
        // group-below-a-plain-row arrangement the user had made.
        return {
          groups: parsed.groups.filter(g => g && typeof g.id === 'string' && Array.isArray(g.sectionIds)),
          collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed : [],
          order: Array.isArray(parsed.order) ? parsed.order : null,
          // Last section the user visited (data-dsa-id). Replayed on the next
          // dialog open: the shell always resets the selection to its first
          // row (rows carry data-modal-autofocus), so without this the user
          // lands on 账号与余额 every time. Survives independently of whether
          // any groups exist.
          lastSection: typeof parsed.lastSection === 'string' ? parsed.lastSection : null,
        };
      } catch { return null; }
    }
    function saveState(state) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
      catch (e) { console.warn('[dsh-settings-arranger] save failed:', e); }
    }
    function clearState() { try { localStorage.removeItem(STORAGE_KEY); } catch {} }

    // ---- locale ----------------------------------------------------------
    function localeText() {
      const lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
      return lang.startsWith('zh') ? 'zh' : 'en';
    }
    const T = {
      zh: {
        arrange: '整理导航', done: '完成',
        newGroup: '＋ 新建分组', reset: '恢复默认',
        resetConfirm: '确定清除自定义排序与分组，恢复原生导航顺序？',
        resetTitle: '恢复默认',
        renameTitle: '重命名分组', newTitle: '新建分组', nameLabel: '分组名称',
        deleteGroupTitle: '删除分组',
        deleteConfirm: '删除分组「{name}」？组内条目将回到未分组区，不会被移除。',
        confirmDelete: '删除', cancel: '取消', ok: '确定',
        duplicateName: '已存在同名分组，请换个名称。',
        groupAria: '设置导航分组', submenuAria: '分组菜单',
        dragAria: '拖拽排序',
      },
      en: {
        arrange: 'Arrange nav', done: 'Done',
        newGroup: '＋ New group', reset: 'Reset to default',
        resetConfirm: 'Clear custom order and groups, restoring the native nav order?',
        resetTitle: 'Reset to default',
        renameTitle: 'Rename group', newTitle: 'New group', nameLabel: 'Group name',
        deleteGroupTitle: 'Delete group',
        deleteConfirm: 'Delete group "{name}"? Its entries return to the ungrouped zone; nothing is removed.',
        confirmDelete: 'Delete', cancel: 'Cancel', ok: 'OK',
        duplicateName: 'A group with this name already exists.',
        groupAria: 'Settings nav group', submenuAria: 'Group menu',
        dragAria: 'Drag to reorder',
      },
    };
    const t = k => T[localeText()][k];
    const tf = (k, map) => t(k).replace(/\{(\w+)\}/g, (_, key) => map[key] ?? '');

    // ---- themed modal (replaces window.prompt/confirm) --------------------
    // One React root hosting a primitives <Modal>; the prompt API resolves a
    // Promise through state. Lazy-mounted on first use.
    const MODAL = {
      _set: null,
      _mounted: false,
      _pending: [], // requests made before the React root committed
      ensure() {
        if (this._mounted) return;
        this._mounted = true;
        const host = document.createElement('div');
        host.dataset.dsaModalHost = '1';
        document.body.appendChild(host);
        ReactDOM.createRoot(host).render(h(ModalHost));
      },
      /** Ask for a text value. Resolves null on cancel. validate(): error string | null. */
      askText({ title, initial = '', placeholder = '', validate }) {
        this.ensure();
        return new Promise(res => {
          const req = { kind: 'text', title, initial, placeholder, validate, res };
          // The React root commits asynchronously; if _set is not wired yet,
          // queue until the ModalHost effect fires.
          if (this._set) this._set(req); else this._pending.push(req);
        });
      },
      /** Ask for a confirmation. Resolves true/false. */
      askConfirm({ title, description, danger, confirmLabel }) {
        this.ensure();
        return new Promise(res => {
          const req = { kind: 'confirm', title, description, danger, confirmLabel, res };
          if (this._set) this._set(req); else this._pending.push(req);
        });
      },
    };

    function ModalHost() {
      const [st, setSt] = React.useState(null);
      React.useEffect(() => {
        MODAL._set = setSt;
        // Flush requests queued before this effect ran.
        if (MODAL._pending.length) {
          const first = MODAL._pending.shift();
          MODAL._pending.forEach(r => r.res(null));
          MODAL._pending = [];
          setSt(first);
        }
        return () => { MODAL._set = null; };
      }, []);
      const close = (value) => {
        if (st && st.res) st.res(value);
        setSt(null);
      };
      const dismiss = () => close(st && st.kind === 'confirm' ? false : null);
      const [value, setValue] = React.useState('');
      const [error, setError] = React.useState(null);
      React.useEffect(() => { setValue(st && st.kind === 'text' ? st.initial : ''); setError(null); }, [st]);
      if (!st) return null;

      const submit = () => {
        if (st.kind === 'confirm') { close(true); return; }
        const v = value.trim();
        if (st.validate) {
          const err = st.validate(v);
          if (err) { setError(err); return; }
        }
        close(v || null);
      };

      // The footer row needs explicit breathing room: P.Modal only spaces the
      // nodes it is given when they carry their own margins, and an input that
      // sits flush against the actions row reads as "buttons stuck to the box".
      const body = st.kind === 'text'
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h(P.Input, {
              autoFocus: true, value, placeholder: st.placeholder,
              'aria-label': st.title,
              onChange: e => { setValue(e.target.value); setError(null); },
              onKeyDown: e => { if (e.key === 'Enter') submit(); },
            }),
            error && h('div', {
              style: { color: 'var(--dsw-alias-state-error-primary, #d5393e)', fontSize: '12px', lineHeight: '18px' },
            }, error))
        : h('div', {
            style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: '20px' },
          }, st.description);

      return h(P.Modal, {
        open: true,
        onClose: dismiss,
        title: st.title,
      },
        body,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '20px' } },
          h(P.Button, { variant: 'ghost', onClick: dismiss }, t('cancel')),
          h(P.Button, {
            variant: 'primary',
            onClick: submit,
            style: st.kind === 'confirm' && st.danger
              ? { background: 'var(--dsw-alias-state-error-primary, #d5393e)' } : undefined,
          }, st.kind === 'confirm' ? (st.confirmLabel || (st.danger ? t('confirmDelete') : t('ok'))) : t('ok')),
        ));
    }

    // ---- CSS ---------------------------------------------------------------
    // All colors/spacing come from dsw theme tokens so light/dark adapt.
    const CSS = `
/* Order-layout container: rows keep React's DOM position, visual order comes
   from style.order assigned in apply(). */
.dsa-nav-list{display:flex !important;flex-direction:column}
.dsa-nav-list > *{min-width:0}
/* Visibility lives in OUR data attribute, never in className: the host shell
   re-renders its rows with className/aria-current whenever the active section
   changes, which silently wipes any class we add. (That was the "a grouped row
   leaks out of its group and never hides again" bug.) */
.dsa-nav-list > [data-dsa-hidden="1"]{display:none !important}

/* Accent: follow the ACTIVE theme's brand colour. The shell also ships the legacy
   alias --dsw-alias-brand-primary-new-colorprimary-new-color, but it is a frozen
   hard-coded value (DeepSeek blue) that ignores skins/themes — reading it left our
   highlights on the old accent. --dsw-alias-brand-primary is what the theme/skin
   actually drives, so resolve it once here and reuse it via --dsa-accent. */
.dsa-nav-list{--dsa-accent:var(--dsw-alias-brand-primary, var(--dsw-alias-onboarding-accent, currentColor))}

/* Groups vs. plain rows: keep the two zones visibly apart. A group head draws a
   hairline above itself (skipped for the very first block); a group whose last
   visible element is followed by a plain row closes with a hairline + breathing
   room, so "two ordinary rows" can never read as "a group that lost its head". */
.dsa-nav-list > [data-dsa-sep="1"]{border-top:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))}
.dsa-group-head[data-dsa-sep="1"]{margin-top:8px}
.dsa-editing .dsa-group-head[data-dsa-sep="1"]{margin-top:12px}
.dsa-nav-list > [data-dsa-end="1"]{border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));padding-bottom:8px}
.dsa-editing > [data-dsa-end="1"]{padding-bottom:12px}
/* Group heads read as containers, not as plain rows: a brand-coloured spine.
   Painted as border-left (NOT inset box-shadow): Chromium drops the straight
   segments of an inset box-shadow on an element that also carries a border and
   a border-radius, at fractional raster scales (Windows display scaling like
   110%/125%/130% or a fractional page zoom) — the spine then renders as two
   arcs with a hole in the middle. Borders themselves rasterize correctly at
   any scale, so the spine rides the border path instead. Left padding is
   reduced 12px→9px so the content column stays pixel-identical. */
/* Edit mode: member rows indent under their group head, so a group's extent
   stays obvious while sorting. */
.dsa-editing [data-dsa-member="1"]{padding-left:28px}


/* Group head — normal mode: styled like a native navCell (40px, 14px label). */
.dsa-group-head{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:40px;padding:9px 16px 9px 9px;
  width:100%;text-align:left;background:none;border:none;cursor:pointer;user-select:none;
  border-left:3px solid var(--dsa-accent, var(--dsw-alias-label-secondary));
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;font-weight:400;line-height:22px;
  border-radius:var(--dsw-radius-md)}
.dsa-group-head:hover{background:var(--dsw-specific-sidebar-nav-item-hover, var(--dsw-alias-interactive-bg-hover))}
/* Edit mode: compact section header above its inline rows. */
.dsa-editing .dsa-group-head{height:30px;padding:4px 12px 4px 9px;font-size:12px;font-weight:600;letter-spacing:.4px;
  color:var(--dsw-alias-label-secondary);text-transform:none}
.dsa-editing .dsa-group-head:hover{color:var(--dsw-alias-label-primary)}
.dsa-caret{flex:none;display:inline-block;width:9px;text-align:center;transition:transform .15s ease;font-size:9px;line-height:1;color:var(--dsw-alias-label-secondary)}
/* Normal mode: ▶ closed, ▼ open (menu showing). Edit mode: the head is a
   disclosure for inline rows, so ▼ expanded / ▶ collapsed. */
.dsa-group-head[data-open="1"] .dsa-caret{transform:rotate(90deg)}
.dsa-editing .dsa-group-head .dsa-caret{transform:rotate(0deg)}
.dsa-editing .dsa-group-head[data-collapsed="1"] .dsa-caret{transform:rotate(-90deg)}
.dsa-group-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* Edit-only affordances: rename + delete buttons. */
.dsa-group-actions{display:none;flex:none;gap:2px}
.dsa-editing .dsa-group-actions{display:flex}
.dsa-group-btn{flex:none;border:none;background:none;color:inherit;cursor:pointer;padding:2px 4px;font-size:11px;line-height:1;border-radius:4px;font-family:inherit}
.dsa-group-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-group-btn[data-armed="1"]{color:#fff;background:var(--dsw-alias-state-error-primary, #d5393e)}
/* Edit footer */
.dsa-nav-footer{flex:none;display:none;flex-direction:column;gap:4px;padding:4px 12px 16px}
.dsa-editing .dsa-nav-footer{display:flex}
.dsa-footer-btn{box-sizing:border-box;width:100%;text-align:left;border:none;background:none;cursor:pointer;
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;padding:6px 4px;border-radius:var(--dsw-radius-md);font-family:inherit}
.dsa-footer-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsa-footer-btn[data-variant="danger"]:hover{color:var(--dsw-alias-state-error-primary, #d5393e)}
/* Reset sits apart from the create action: it is destructive and global, so a
   hairline rule keeps it from being hit on the way to 新建分组. */
.dsa-footer-btn[data-variant="danger"]{margin-top:4px;padding-top:9px;
  border-top:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));border-radius:0}
/* Drag affordances (edit mode only). ⋮⋮ span for icon-less rows; rows with a
   native icon svg reuse the svg itself via .dsa-drag-svg. */
.dsa-drag-handle{display:none;flex:none;cursor:grab;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  font-size:10px;letter-spacing:-1px;user-select:none;padding:0 2px}
.dsa-editing .dsa-drag-handle{display:inline}
.dsa-editing [data-dsa-dragsvg="1"]{cursor:grab;opacity:.9}
.dsa-editing [draggable="true"]{cursor:grab}
.dsa-drop-before{box-shadow:0 -2px 0 0 var(--dsa-accent, currentColor)}
.dsa-drop-after{box-shadow:0 2px 0 0 var(--dsa-accent, currentColor)}
/* Group heads keep their spine while a drop marker is shown. */
/* The head's spine is a constant border-left now, so drop marks only add the
   edge line (the old rules had to re-assert the inset spine they replaced). */
.dsa-group-head.dsa-drop-before{box-shadow:0 -2px 0 0 var(--dsa-accent, currentColor)}
.dsa-group-head.dsa-drop-after{box-shadow:0 2px 0 0 var(--dsa-accent, currentColor)}
.dsa-dragging{opacity:.4}
@media (hover:none){.dsa-drag-handle{display:none !important}.dsa-editing [draggable="true"]{cursor:auto}}

/* Dropdown submenu (normal mode). Portaled to body, positioned over the nav.
   Fill matches the shell's MenuSurface (translucent fill + blur) so it reads as
   a floating layer against both themes. */
.dsa-submenu{position:fixed;z-index:1100;min-width:176px;max-height:320px;overflow-y:auto;padding:4px;
  background:var(--dsw-alias-bg-layer-2);backdrop-filter:var(--dsw-menu-backdrop-filter, blur(16px));
  border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14));border-radius:var(--dsw-radius-md);
  box-shadow:var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.35))}
.dsa-submenu-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;height:32px;padding:0 10px;
  background:none;border:none;cursor:pointer;text-align:left;font-family:inherit;font-size:13px;line-height:18px;
  color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm)}
.dsa-submenu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-submenu-item[data-active="1"]{color:var(--dsa-accent, currentColor)}
.dsa-submenu-item[data-active="1"] .dsa-submenu-icon{color:var(--dsa-accent, currentColor)}
/* Active marker slot: one fixed 4px column on EVERY item so the active dot
   never pushes its label right. The dot is a child (not ::before) because a
   zero-width transparent ::before would still shift the selected row. */
.dsa-submenu-dot{flex:none;width:4px;height:4px;border-radius:50%;background:transparent}
.dsa-submenu-item[data-active="1"] .dsa-submenu-dot{background:var(--dsa-accent, currentColor)}
.dsa-submenu-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;
  width:16px;height:16px;color:var(--dsw-alias-label-secondary)}
.dsa-submenu-icon>svg{width:16px;height:16px;display:block}
.dsa-submenu-icon>img{width:16px;height:16px;object-fit:contain;display:block}
.dsa-submenu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-submenu-empty{padding:8px 10px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-size:12px}
`;
    function injectCss() {
      if (document.getElementById('dsa-style')) return;
      const tag = document.createElement('style');
      tag.id = 'dsa-style';
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---- action button component (settings.action slot) -------------------
    // The shell renders the registered component with OWNER props (no custom
    // props survive), so the component reads ARRANGER state directly.
    function ActionButton() {
      return h('button', {
        type: 'button',
        'data-dsa-action': '1',
        onClick: () => ARRANGER.setEditing(!ARRANGER.editing),
        style: {
          boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2, transparent)',
          borderRadius: 'var(--dsw-radius-sm)', cursor: 'pointer', height: '28px',
          padding: '0 8px', display: 'inline-flex', alignItems: 'center', gap: '4px',
          color: ARRANGER.editing ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
          background: ARRANGER.editing ? 'var(--dsw-alias-interactive-bg-hover, transparent)' : 'transparent',
          fontFamily: 'inherit', fontSize: '12px', fontWeight: 500, lineHeight: '18px',
        },
      }, ARRANGER.editing ? t('done') : t('arrange'));
    }

    // ---- nav enhancement --------------------------------------------------
    const ARRANGER = {
      editing: false,
      state: loadState(),
      navList: null,
      observer: null,
      cleanupFns: [],
      _t: 0,     // pending full-render debounce
      _raf: 0,   // pending post-render re-check
      _suppress: false,
      submenu: null, // {el, gid, onClose}
      /** Single read path for mutation handlers: always the freshest persisted
          copy, never a hand-built object missing newer top-level keys (order). */
      snapshot() {
        return loadState() || this.state || { groups: [], collapsed: [], order: [], lastSection: null };
      },

      /** Remember the section the user just opened (row identity). Only real
       *  user clicks record; our own replay click is isTrusted=false and the
       *  submenu item handler calls this directly before replaying. */
      recordLast(id) {
        if (!id) return;
        const st = this.snapshot();
        if (st.lastSection === id) return;
        st.lastSection = id;
        this.state = st;
        saveState(st);
      },

      /** Once per dialog mount: restore the user's last section after the
       *  shell finished its own initial focus pass. One delayed attempt, no
       *  retries — if the row is gone (removed / locale switched) stay silent. */
      scheduleReplay() {
        clearTimeout(this._replayT);
        this._replayT = setTimeout(() => this.replayLast(), 100);
      },

      replayLast() {
        if (this.editing || !this.navList || !this.navList.isConnected) return;
        const id = this.snapshot().lastSection;
        if (!id) return;
        const row = this.nativeRows().find(r => r.id === id);
        // Unknown id (row deleted, label changed with the locale): skip quietly.
        if (!row) return;
        // Already the active section (e.g. the shell kept the selection): no-op.
        if (row.el.getAttribute('aria-current') === 'true') return;
        row.el.click();
        // element.click() does not move keyboard focus, but the shell focused
        // its first row on open — follow the selection so the focus ring and
        // the highlight agree.
        try { row.el.focus({ preventScroll: true }); } catch { row.el.focus(); }
      },
      setEditing(v) {
        this.editing = v;
        this.closeSubmenu();
        this.ensureNav();
        if (this.navList) this.navList.classList.toggle('dsa-editing', v);
        document.querySelectorAll('[data-dsa-action]').forEach(btn => {
          if (btn.textContent !== (v ? t('done') : t('arrange'))) btn.textContent = v ? t('done') : t('arrange');
          btn.style.color = v ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)';
          btn.style.background = v ? 'var(--dsw-alias-interactive-bg-hover, transparent)' : 'transparent';
        });
        this.render();
      },

      /** Lazily re-anchor the nav list if we lost it (dialog re-render). */
      ensureNav() {
        if (this.navList && this.navList.isConnected) return;
        const list = findNavList();
        if (list && list !== this.navList) {
          list.classList.add('dsa-nav-list');
          list.setAttribute('data-dsa-anchored', '1');
          tagRows(list);
          this.watch(list);
          this.navList = list;
        } else {
          this.navList = list;
        }
      },

      /** Native rows in their original order (slot order), keyed by data-dsa-id. */
      nativeRows() {
        this.ensureNav();
        if (!this.navList) return [];
        // Native rows are the shell's own buttons; anything we insert (group
        // head, footer) is never a row. A market update may remount the list
        // with an extra wrapper, so fall back to a scoped query when the
        // direct-children pass finds nothing.
        let els = [...this.navList.children].filter(el => el.tagName === 'BUTTON');
        if (!els.length) els = [...this.navList.querySelectorAll('button')];
        return els
          .filter(el => !el.classList.contains('dsa-group-head'))
          .map(el => ({ el, id: el.getAttribute('data-dsa-id') }))
          .filter(r => r.id);
      },

      apply() {
        if (!this.navList || !this.navList.isConnected) return;
        const list = this.navList;
        if (!this.editing) this.closeSubmenu();
        this._suppress = true;
        clearTimeout(this._suppressT);
        this._suppressT = setTimeout(() => { this._suppress = false; }, 0);
        // CSS-order strategy: NEVER move React's row nodes (moving them makes
        // reconciliation drop them). Mark the list as order-layout and assign
        // style.order to heads/rows/footer from state.
        list.querySelectorAll(':scope > [data-dsa-own="1"]').forEach(e => e.remove());
        // Re-identity freshly mounted nav rows (e.g. a plugin update that
        // re-registers its section): new nodes carry no data-dsa-id yet, and
        // nativeRows() only sees tagged rows — an untagged row would keep its
        // native position and keep showing outside its group (that was the
        // "plugin updated in the market, entry pops out of the group" bug).
        // Refresh ⇒ re-anchor and re-tag, which is why reloading fixed it.
        tagRows(list);
        const rows = this.nativeRows();
        const rowIds = rows.map(r => r.id);
        const byId = new Map(rows.map(r => [r.id, r.el]));
        // Normalize (and migrate) the layout model before deciding anything:
        // this.state may still carry the older groups + __misc__ shape.
        const norm = normalizeState(this.state, rowIds);
        this.state = norm;
        const groups = norm.groups;
        const collapsed = norm.collapsed;
        const hasData = groups.length > 0;
        const idle = !this.editing && !hasData;
        list.classList.toggle('dsa-nav-list', !idle);
        list.classList.toggle('dsa-editing', !!this.editing);
        if (idle) {
          // No custom layout: hand the nav back to the shell untouched.
          for (const r of rows) {
            r.el.style.order = '';
            r.el.removeAttribute('draggable');
            delete r.el.dataset.dsaDnd;
            setFlag(r.el, 'data-dsa-hidden', false);
            setFlag(r.el, 'data-dsa-member', false);
            setFlag(r.el, 'data-dsa-end', false);
            r.el.querySelector('.dsa-drag-handle')?.remove();
            setFlag(r.el.querySelector(':scope > svg'), 'data-dsa-dragsvg', false);
          }
          return;
        }
        const members = new Set();
        for (const g of groups) for (const id of g.sectionIds) members.add(id);
        // Row decorations: drag affordances in edit mode + membership mark.
        for (const r of rows) {
          const svg = r.el.querySelector(':scope > svg');
          if (this.editing) {
            // Reuse the row's native icon svg as drag affordance when present
            // (avoids the double-icon look); otherwise insert a ⋮⋮ handle.
            if (svg) setFlag(svg, 'data-dsa-dragsvg', true);
            else if (!r.el.querySelector('.dsa-drag-handle')) {
              const hs = document.createElement('span');
              hs.className = 'dsa-drag-handle';
              hs.textContent = '⋮⋮';
              hs.setAttribute('aria-hidden', 'true');
              r.el.insertBefore(hs, r.el.firstChild);
            }
            this.attachDnd(r.el, { kind: 'row', id: r.id });
          } else {
            r.el.querySelector('.dsa-drag-handle')?.remove();
            setFlag(svg, 'data-dsa-dragsvg', false);
            r.el.removeAttribute('draggable');
          }
          setFlag(r.el, 'data-dsa-member', !!this.editing && members.has(r.id));
        }
        // Layout model (v0.4): walk the top-level block sequence — each block is
        // either a group (head + members) or a single ungrouped row — so a group
        // can sit above or below any plain row. Nodes are never moved;
        // style.order carries the visual order.
        const blockEls = [];
        const assigned = new Set();
        for (const b of norm.order) {
          if (b.kind === 'group') {
            const g = groups.find(x => x.id === b.id);
            if (!g) continue;
            // Assigned first-wins: a row listed twice (stale state) renders once.
            const items = [{ kind: 'head', gid: g.id, label: g.label || g.id }];
            const uniq = [...new Set(g.sectionIds)].filter(id => byId.has(id) && !assigned.has(id));
            for (const id of uniq) { items.push({ kind: 'row', id }); assigned.add(id); }
            blockEls.push({ kind: 'group', items });
          } else {
            if (assigned.has(b.id) || !byId.has(b.id)) continue;
            assigned.add(b.id);
            blockEls.push({ kind: 'row', items: [{ kind: 'row', id: b.id }] });
          }
        }
        const layout = [];
        for (const blk of blockEls) for (const item of blk.items) layout.push(item);
        // Materialize our own nodes and insert each one right before the first
        // row it covers (visual order still comes from style.order).
        const heads = new Map(); // layout index -> element
        layout.forEach((item, i) => {
          if (item.kind === 'row') { item.el = byId.get(item.id); return; }
          item.el = this.editing ? this.buildHeadEdit(item.gid, item.label) : this.buildHeadMenu(item.gid, item.label);
          heads.set(i, item.el);
          const nextRow = layout.slice(i + 1).find(x => x.kind === 'row' && byId.has(x.id));
          if (nextRow) list.insertBefore(item.el, byId.get(nextRow.id));
          else list.appendChild(item.el);
        });
        // Assign order; the first group head skips the divider above it.
        let order = 0;
        let firstSection = true;
        layout.forEach((item, i) => {
          const el = item.el || (item.kind === 'row' ? byId.get(item.id) : heads.get(i));
          if (!el) return;
          el.style.order = order++;
          if (item.kind === 'row') return;
          setFlag(el, 'data-dsa-sep', !firstSection);
          firstSection = false;
        });
        // Editing footer goes last, and only exists while editing.
        if (this.editing) {
          const footer = this.buildFooter();
          footer.style.order = 10000;
          list.appendChild(footer);
        }
        // Visibility: normal mode hides ALL grouped rows (the head's submenu
        // carries them); edit mode shows them inline but still hides the rows
        // of a COLLAPSED group — a collapsed group must look collapsed, not
        // merely dimmed (user's call: "全部不显示，效果等于分组收起状态").
        const hidden = new Set();
        for (const g of groups) {
          if (!this.editing || (collapsed || []).includes(g.id)) {
            for (const id of g.sectionIds) hidden.add(id);
          }
        }
        for (const r of rows) setFlag(r.el, 'data-dsa-hidden', hidden.has(r.id));
        // Group-end rule: mark the group block's last VISIBLE element, so the
        // boundary with a following plain row (or the end of the nav) is obvious.
        for (const r of rows) setFlag(r.el, 'data-dsa-end', false);
        blockEls.forEach((blk, bi) => {
          if (blk.kind !== 'group') return;
          const next = blockEls[bi + 1];
          if (next && next.kind === 'group') return; // the next head draws its own divider
          let last = null;
          for (const item of blk.items) if (item.el && !hidden.has(item.id)) last = item.el;
          setFlag(last, 'data-dsa-end', true);
        });
      },

      // -- normal mode head: native-looking row that opens a submenu -------
      buildHeadMenu(gid, label) {
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'dsa-group-head';
        head.setAttribute('data-dsa-own', '1');
        head.setAttribute('data-dsa-kind', 'group');
        head.setAttribute('data-dsa-group', gid);
        head.setAttribute('aria-haspopup', 'menu');
        const caret = document.createElement('span');
        caret.className = 'dsa-caret'; caret.textContent = '▶';
        const title = document.createElement('span');
        title.className = 'dsa-group-title'; title.textContent = label;
        head.appendChild(caret); head.appendChild(title);
        head.addEventListener('click', () => this.toggleSubmenu(gid, label, head));
        return head;
      },

      toggleSubmenu(gid, label, head) {
        // Edit mode is the "everything inline" view: the head toggles collapse
        // there, so a submenu would be a second, conflicting way to see the
        // same rows (that double behaviour is what the user reported).
        if (this.editing) { this.closeSubmenu(); return; }
        if (this.submenu && this.submenu.gid === gid) { this.closeSubmenu(); return; }
        this.closeSubmenu();
        const st = this.snapshot();
        const g = st.groups.find(x => x.id === gid);
        const memberIds = (g?.sectionIds || []).slice();
        const menu = document.createElement('div');
        menu.className = 'dsa-submenu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', label);
        // The menu is portaled to <body>, outside the shell's token scope, so
        // carry the nav's resolved accent over explicitly (empty -> CSS default).
        const navAccent = this.navList
          ? getComputedStyle(this.navList).getPropertyValue('--dsa-accent').trim()
          : '';
        if (navAccent) menu.style.setProperty('--dsa-accent', navAccent);
        let items = 0;
        for (const id of memberIds) {
          const rowEl = this.navList && this.navList.querySelector(`[data-dsa-id="${cssQuote(id)}"]`);
          if (!rowEl) continue;
          items++;
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'dsa-submenu-item';
          item.setAttribute('role', 'menuitem');
          item.setAttribute('data-active', rowEl.getAttribute('aria-current') === 'true' ? '1' : '0');
          item.setAttribute('data-dsa-target', id);
          // Marker column first, always present: the selected row must NOT sit
          // further left than the rest (user's call), so the slot is fixed on
          // every item and only its colour changes.
          const dot = document.createElement('span');
          dot.className = 'dsa-submenu-dot';
          dot.setAttribute('aria-hidden', 'true');
          item.appendChild(dot);
          // Carry the row's own icon over, so the menu mirrors the nav instead
          // of showing a bare text label (users match entries by icon shape).
          const icon = rowEl.querySelector(':scope > svg, :scope > img');
          if (icon) {
            const box = document.createElement('span');
            box.className = 'dsa-submenu-icon';
            box.setAttribute('aria-hidden', 'true');
            box.appendChild(icon.cloneNode(true));
            item.appendChild(box);
          }
          const label = document.createElement('span');
          label.className = 'dsa-submenu-label';
          label.textContent = id;
          item.appendChild(label);
          item.addEventListener('click', () => {
            // Record BEFORE the programmatic row click: rowEl.click() is not
            // isTrusted, so the nav-level listener ignores it — this call is
            // the only record path for grouped (submenu) entries.
            this.recordLast(id);
            this.closeSubmenu();
            rowEl.click();
          });
          menu.appendChild(item);
        }
        if (items === 0) {
          const empty = document.createElement('div');
          empty.className = 'dsa-submenu-empty';
          empty.textContent = MISC_LABEL[localeText()] === '其他' ? '（空分组）' : '(empty)';
          menu.appendChild(empty);
        }
        // Position below the head, clamped into the viewport.
        document.body.appendChild(menu);
        // Measure against the visible group header. In edit mode `head` is the
        // action bar (rename/delete at the row's right end), which would park
        // the menu under the wrong thing.
        const anchor = (this.navList && this.navList.querySelector(`.dsa-group-head[data-dsa-group="${cssQuote(gid)}"]`)) || head;
        const r = anchor.getBoundingClientRect();
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        let left = Math.min(r.left, window.innerWidth - mw - 8);
        let top = r.bottom + 4;
        if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
        menu.style.left = `${Math.max(8, left)}px`;
        menu.style.top = `${top}px`;
        if (anchor !== head) anchor.setAttribute('data-open', '1');
        head.setAttribute('data-open', '1');
        // Outside click / Escape closes.
        const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== head && !head.contains(e.target)) this.closeSubmenu(); };
        const onKey = (e) => { if (e.key === 'Escape') this.closeSubmenu(); };
        document.addEventListener('pointerdown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
        this.submenu = { el: menu, gid, onClose: () => {
          head.removeAttribute('data-open');
          document.removeEventListener('pointerdown', onDoc, true);
          document.removeEventListener('keydown', onKey, true);
          menu.remove();
        } };
      },

      closeSubmenu() {
        if (this.submenu) { this.submenu.onClose(); this.submenu = null; }
      },

      // -- edit mode head: caret + title + rename/delete --------------------
      buildHeadEdit(gid, label) {
        const head = document.createElement('div');
        head.className = 'dsa-group-head';
        head.setAttribute('data-dsa-own', '1');
        head.setAttribute('data-dsa-group', gid);
        head.setAttribute('data-dsa-kind', 'group');
        head.setAttribute('role', 'button');
        const collapsed = (this.state && this.state.collapsed) || [];
        head.setAttribute('data-collapsed', collapsed.includes(gid) ? '1' : '0');
        const handle = document.createElement('span');
        handle.className = 'dsa-drag-handle';
        handle.textContent = '⋮⋮';
        handle.setAttribute('aria-hidden', 'true');
        const caret = document.createElement('span');
        caret.className = 'dsa-caret'; caret.textContent = '▼';
        const title = document.createElement('span');
        title.className = 'dsa-group-title'; title.textContent = label;
        head.appendChild(handle); head.appendChild(caret); head.appendChild(title);
        head.addEventListener('click', () => {
          const nowCollapsed = head.getAttribute('data-collapsed') !== '1';
          head.setAttribute('data-collapsed', nowCollapsed ? '1' : '0');
          const st = this.snapshot();
          st.collapsed = nowCollapsed
            ? [...new Set([...(st.collapsed || []), gid])]
            : (st.collapsed || []).filter(c => c !== gid);
          this.state = st; saveState(st); this.apply();
        });
        // Rename through the themed modal; duplicate labels are rejected.
        const actions = document.createElement('span');
        actions.className = 'dsa-group-actions';
        const rename = document.createElement('button');
        rename.className = 'dsa-group-btn'; rename.textContent = '✎'; rename.title = t('renameTitle');
        rename.addEventListener('click', e => {
          e.stopPropagation();
          this.renameGroup(gid, label);
        });
        // Delete with two-step inline confirmation (accident guard).
        const del = document.createElement('button');
        del.className = 'dsa-group-btn'; del.textContent = '✕'; del.title = t('deleteGroupTitle');
        let disarm = null;
        del.addEventListener('click', e => {
          e.stopPropagation();
          if (del.dataset.armed !== '1') {
            del.dataset.armed = '1';
            del.textContent = '✓';
            del.title = t('confirmDelete');
            disarm = setTimeout(() => { del.dataset.armed = ''; del.textContent = '✕'; del.title = t('deleteGroupTitle'); }, 4000);
            return;
          }
          clearTimeout(disarm);
          this.deleteGroup(gid);
        });
        actions.appendChild(rename); actions.appendChild(del);
        head.appendChild(actions);
        if (this.editing) this.attachDnd(head, { kind: 'group', id: gid });
        return head;
      },

      async renameGroup(gid, current) {
        const st = this.snapshot();
        const grp = st && st.groups.find(x => x.id === gid);
        if (!grp) return;
        const label = await MODAL.askText({
          title: t('renameTitle'),
          initial: grp.label || gid,
          validate: v => !v ? t('nameLabel') : (st.groups.some(x => x.id !== gid && (x.label || x.id).trim().toLowerCase() === v.toLowerCase()) ? t('duplicateName') : null),
        });
        if (label == null) return;
        const st2 = this.snapshot();
        const g2 = st2.groups.find(x => x.id === gid);
        if (g2) { g2.label = label.trim() || g2.label; this.state = st2; saveState(st2); this.render(); }
      },

      async deleteGroup(gid) {
        const st = this.snapshot();
        const grp = st && st.groups.find(x => x.id === gid);
        if (!grp) return;
        const ok = await MODAL.askConfirm({
          title: t('deleteGroupTitle'),
          description: tf('deleteConfirm', { name: grp.label || gid }),
          danger: true,
        });
        if (!ok) return;
        const st2 = this.snapshot();
        st2.groups = (st2.groups || []).filter(x => x.id !== gid);
        st2.collapsed = (st2.collapsed || []).filter(c => c !== gid);
        // Freed members return as plain top-level rows: drop the group's block
        // here (normalizeState/orderFrom would prune it anyway).
        st2.order = (st2.order || []).filter(b => !(b && b.kind === 'group' && b.id === gid));
        this.state = st2; saveState(st2); this.render();
      },

      buildFooter() {
        const footer = document.createElement('div');
        footer.className = 'dsa-nav-footer';
        // Must carry our ownership mark: apply() purges [data-dsa-own="1"], so
        // without it every render in edit mode stacked another footer.
        footer.setAttribute('data-dsa-own', '1');
        const newBtn = document.createElement('button');
        newBtn.className = 'dsa-footer-btn'; newBtn.textContent = t('newGroup');
        newBtn.addEventListener('click', async () => {
          const st = this.snapshot();
          const label = await MODAL.askText({
            title: t('newTitle'),
            initial: '',
            validate: v => !v ? t('nameLabel') : (st.groups.some(x => (x.label || x.id).trim().toLowerCase() === v.toLowerCase()) ? t('duplicateName') : null),
          });
          if (!label) return;
          const st2 = this.snapshot();
          const id = 'g' + Date.now().toString(36);
          st2.groups.push({ id, label: label.trim(), sectionIds: [] });
          this.state = st2; saveState(st2); this.render();
        });
        const resetBtn = document.createElement('button');
        resetBtn.className = 'dsa-footer-btn'; resetBtn.dataset.variant = 'danger';
        resetBtn.textContent = t('reset');
        resetBtn.addEventListener('click', async () => {
          const ok = await MODAL.askConfirm({ title: t('resetTitle'), description: t('resetConfirm'), danger: true, confirmLabel: t('reset') });
          if (!ok) return;
          clearState(); this.state = null; this.render();
        });
        footer.appendChild(newBtn); footer.appendChild(resetBtn);
        return footer;
      },

      /** Drag & drop: reorder within/across groups. Touch disabled by CSS (no handle) + guard. */
      attachDnd(el, ref) {
        // Re-assert: the host may have re-rendered this node since we attached.
        el.draggable = true;
        if (el.dataset.dsaDnd === '1') return;
        el.dataset.dsaDnd = '1';
        el.addEventListener('dragstart', e => {
          if (e.pointerType === 'touch' || !this.editing) { e.preventDefault(); return; }
          el.classList.add('dsa-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/dsa', JSON.stringify(ref));
        });
        el.addEventListener('dragend', () => { el.classList.remove('dsa-dragging'); this.clearMarks(); });
        el.addEventListener('dragover', e => {
          if (!this.editing) return;
          e.preventDefault();
          const rect = el.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          this.clearMarks();
          el.classList.add(before ? 'dsa-drop-before' : 'dsa-drop-after');
        });
        el.addEventListener('dragleave', () => { el.classList.remove('dsa-drop-before', 'dsa-drop-after'); });
        el.addEventListener('drop', e => {
          if (!this.editing) return;
          e.preventDefault(); e.stopPropagation();
          this.clearMarks();
          let src;
          try { src = JSON.parse(e.dataTransfer.getData('text/dsa')); } catch { return; }
          if (!src || !src.id) return;
          const rect = el.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          const isHead = el.classList.contains('dsa-group-head');
          const target = {
            kind: isHead ? 'group' : 'row',
            id: isHead ? el.getAttribute('data-dsa-group') : el.getAttribute('data-dsa-id'),
          };
          if (!target.id) return;
          this.move(src, target, before);
        });
      },

      clearMarks() {
        this.navList?.querySelectorAll('.dsa-drop-before, .dsa-drop-after')
          .forEach(n => n.classList.remove('dsa-drop-before', 'dsa-drop-after'));
      },

      /** Move source into the model, persist, re-render.
       *  Model: groups carry membership, state.order is the flat top-level block
       *  sequence (group blocks + single ungrouped rows). Dragging a group onto a
       *  plain row parks the whole group block right above/below that row. */
      move(src, target, before) {
        if (!src || !src.id || !target || !target.id) return;
        if (src.kind === target.kind && src.id === target.id) return;
        // Always start from persisted state: this.state may be stale/null if
        // another surface (or a page reload) changed it since last render.
        const rowIds = this.nativeRows().map(r => r.id);
        const st = normalizeState(this.snapshot(), rowIds);
        const groupOf = id => st.groups.find(g => g.sectionIds.includes(id));
        const removeFromAnyGroup = (id) => {
          const g = groupOf(id);
          if (g) g.sectionIds = g.sectionIds.filter(x => x !== id);
        };
        const blocks = st.order.map(b => ({ ...b }));
        const at = (kind, id) => blocks.findIndex(b => b.kind === kind && b.id === id);
        const dropBlock = (kind, id) => { const i = at(kind, id); if (i >= 0) blocks.splice(i, 1); return i; };

        if (src.kind === 'group') {
          if (at('group', src.id) < 0) return;
          // Dropping a group onto one of its own member rows is a no-op.
          const owner = target.kind === 'row' ? groupOf(target.id) : null;
          if (owner && owner.id === src.id) return;
          // Anchor: a group head anchors on itself, a member row anchors on its
          // whole group block, a plain row anchors on its own block.
          const anchor = target.kind === 'group'
            ? { kind: 'group', id: target.id }
            : (owner ? { kind: 'group', id: owner.id } : { kind: 'row', id: target.id });
          const to0 = at(anchor.kind, anchor.id);
          let to = to0 < 0 ? blocks.length : (before ? to0 : to0 + 1);
          const from = dropBlock('group', src.id);
          if (from >= 0 && from < to) to--;
          blocks.splice(to, 0, { kind: 'group', id: src.id });
        } else if (target.kind === 'group') {
          const g = st.groups.find(x => x.id === target.id);
          if (!g) return;
          removeFromAnyGroup(src.id);
          dropBlock('row', src.id);
          if (before) g.sectionIds.unshift(src.id);
          else g.sectionIds.push(src.id);
        } else {
          // Row target: resolve its container BEFORE removing the source, then
          // insert relative to the target's index after the removal (the index
          // shifts when the source sat earlier in the same list).
          const targetGroup = groupOf(target.id);
          removeFromAnyGroup(src.id);
          dropBlock('row', src.id);
          if (targetGroup) {
            const ti = targetGroup.sectionIds.indexOf(target.id);
            targetGroup.sectionIds.splice(ti < 0 ? targetGroup.sectionIds.length : (before ? ti : ti + 1), 0, src.id);
          } else {
            // Plain top-level row: the source becomes a block of its own right
            // above/below the target row's block (this is how a row leaves a
            // group, and how a group gets parked around a single row).
            const ti = at('row', target.id);
            const to = ti < 0 ? blocks.length : (before ? ti : ti + 1);
            blocks.splice(to, 0, { kind: 'row', id: src.id });
          }
        }
        st.order = orderFrom(blocks, st, rowIds);
        this.state = st;
        saveState(st);
        this.render();
      },

      /** Re-assert our attribute marks after a host re-render may have reset them. */
      syncFlags() {
        if (!this.navList || !this.navList.isConnected) return;
        // Derive flags ONLY from in-memory state — never re-normalize here.
        // This runs in the middle of a host commit: nativeRows() may be
        // transiently incomplete (old row removed, new row not yet inserted),
        // and re-normalizing would treat a missing member row as "section
        // gone" and evict it from its group — the plugin-market-update bug.
        const st = this.state;
        const groups = (st && st.groups) || [];
        if (!groups.length && !this.editing) return;
        const collapsed = (st && st.collapsed) || [];
        const hidden = new Set();
        const members = new Set();
        for (const g of groups) {
          for (const id of g.sectionIds) {
            members.add(id);
            // Collapsed groups stay hidden even in edit mode (see apply()).
            if (!this.editing || collapsed.includes(g.id)) hidden.add(id);
          }
        }
        for (const r of this.nativeRows()) {
          setFlag(r.el, 'data-dsa-hidden', hidden.has(r.id));
          setFlag(r.el, 'data-dsa-member', !!this.editing && members.has(r.id));
        }
      },

      render() {
        try {
          this.apply();
        } catch (e) { console.warn('[dsh-settings-arranger] render failed:', e); }
        // The host may still be mid-commit here (React swaps nav rows in
        // several passes when a plugin is updated from the market): rows that
        // mount after our pass keep their native position and show up outside
        // their group until a reload re-tags them. Re-check once on the next
        // frame — cheap, and only when something is actually untagged.
        if (this._raf) return;
        this._raf = setTimeout(() => {
          this._raf = 0;
          if (this._suppress) return;
          if (this.hasUntagged()) this.settle(1);
        }, 50);
      },

      /** True while any nav button is still missing our identity mark. */
      hasUntagged() {
        const list = this.navList;
        if (!list || !list.isConnected) return false;
        for (const b of list.querySelectorAll('button')) {
          if (b.classList.contains('dsa-group-head')) continue;
          // Our own chrome (head action buttons, footer buttons) is created by
          // buildHead*/buildFooter and carries data-dsa-own — it never needs a
          // row identity, and counting it here would drive endless re-renders.
          if (b.closest('[data-dsa-own]')) continue;
          if (!b.getAttribute('data-dsa-id')) return true;
        }
        return false;
      },

      /** Render, then re-render if the host commit was still settling. Bounded
       *  by `pass` so a pathological host can never drive an endless loop. */
      settle(pass) {
        if (pass > 3) return;
        this.render();
        if (pass < 3 && this.hasUntagged()) {
          clearTimeout(this._t);
          this._t = setTimeout(() => this.settle(pass + 1), 60);
        }
      },

      watch(list) {
        if (this.observer) { this.observer.disconnect(); this.observer = null; }
        if (!list) return;
        this.observer = new MutationObserver(records => {
          if (this._suppress) return;
          // The shell rewrites className/aria-current on its own rows whenever
          // the active section changes, which would silently drop our marks;
          // re-assert them before deciding whether a full re-layout is needed.
          this.syncFlags();
          if (records.some(r => r.type === 'childList')) {
            clearTimeout(this._t);
            this._t = setTimeout(() => this.settle(0), 80);
          }
        });
        this.observer.observe(list, {
          childList: true, subtree: true,
          attributes: true, attributeFilter: ['class', 'aria-current', 'data-modal-autofocus'],
        });
      },
    };

    // Debug/verification handle (harmless in production; useful for test
    // tooling to drive and inspect the plugin from the page console).
    if (typeof window !== 'undefined') window.__dsaArranger = ARRANGER;

    const cssQuote = s => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'));

    /** Idempotent flag write: only touches the DOM when the value differs, so
     *  observer-driven repairs can never feed themselves. */
    function setFlag(el, name, on) {
      if (!el) return;
      if (on) { if (el.getAttribute(name) !== '1') el.setAttribute(name, '1'); }
      else if (el.hasAttribute(name)) el.removeAttribute(name);
    }

    /** Build the top-level block sequence: candidates first (deduped, rows that
     *  belong to a group or no longer exist are dropped), then any group or
     *  ungrouped row the candidate list forgot to mention. */
    function orderFrom(candidates, st, rowIds) {
      const ids = new Set(rowIds);
      const memberOf = new Set();
      for (const g of st.groups) for (const id of g.sectionIds) memberOf.add(id);
      const out = [];
      const seen = new Set();
      const push = (kind, id) => {
        if ((kind !== 'group' && kind !== 'row') || typeof id !== 'string') return;
        const key = kind + ':' + id;
        if (seen.has(key)) return;
        if (kind === 'group') { if (!st.groups.some(g => g.id === id)) return; }
        else if (!ids.has(id) || memberOf.has(id)) return;
        seen.add(key);
        out.push({ kind, id });
      };
      for (const b of (candidates || [])) if (b) push(b.kind, b.id);
      for (const g of st.groups) push('group', g.id);
      for (const id of rowIds) push('row', id);
      return out;
    }

    /** Normalize persisted state into the v0.4 model: groups carry membership,
     *  `order` is a flat top-level sequence mixing group blocks and single
     *  ungrouped rows (so a group can sit above/below any plain row).
     *  Migrates the older {groups:[...{id:'__misc__'}]} shape: its rows become
     *  plain top-level blocks in place. */
    function normalizeState(raw, rowIds) {
      // rowIds only decides block creation in orderFrom; membership is kept
      // verbatim (see comment below), so nothing here needs the id set.
      const st = { groups: [], collapsed: [], order: [] };
      const miscIds = [];
      for (const g of ((raw && raw.groups) || [])) {
        if (!g || !Array.isArray(g.sectionIds)) continue;
        // Membership survives even if the row is transiently absent from the
        // DOM (host commit mid-flight, plugin update, brief un-registration) —
        // render-time only skips ids the nav currently lacks (orderFrom keeps
        // row blocks only for ids that exist). Deleting membership here is why
        // re-mounted rows used to drop out of their group for good.
        const seen = new Set();
        const sectionIds = g.sectionIds.filter(id => typeof id === 'string' && !seen.has(id) && seen.add(id));
        if (g.id === '__misc__') { miscIds.push(...sectionIds); continue; }
        st.groups.push({ id: g.id, label: g.label || g.id, sectionIds });
      }
      for (const c of ((raw && raw.collapsed) || [])) {
        if (typeof c === 'string' && st.groups.some(g => g.id === c) && !st.collapsed.includes(c)) st.collapsed.push(c);
      }
      const rawOrder = raw && Array.isArray(raw.order) ? raw.order : null;
      const candidates = (rawOrder && rawOrder.length)
        ? rawOrder
        : [...st.groups.map(g => ({ kind: 'group', id: g.id })), ...miscIds.map(id => ({ kind: 'row', id }))];
      st.order = orderFrom(candidates, st, rowIds);
      // Carry the last-visited section through normalization (apply() replaces
      // this.state with the normalized copy; dropping the field here would
      // silently erase it on every render).
      st.lastSection = (raw && typeof raw.lastSection === 'string') ? raw.lastSection : null;
      return st;
    }

    function findNavList() {
      // Settings dialog renders its nav list as a flex-column container of
      // section buttons (each button[data-modal-autofocus] or [aria-current]).
      // Structural anchor: dialog overlay panel with a nav column whose direct
      // children include ≥3 such buttons.
      const panels = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      for (const panel of panels) {
        for (const btn of panel.querySelectorAll('button[data-modal-autofocus], button[aria-current]')) {
          const list = btn.parentElement;
          if (!list) continue;
          // An already-anchored list is still a valid candidate while it is
          // connected (the marker only prevents double boot in boot()).
          if (list.getAttribute('data-dsa-anchored') === '1' && list.isConnected) return list;
          const buttons = [...list.children].filter(c => c.tagName === 'BUTTON');
          if (buttons.length >= 3) return list;
        }
      }
      return null;
    }

    function tagRows(list) {
      // Walk every button, not just direct children: a market update can
      // remount the nav list with an extra wrapper in between, and rows that
      // live one level deeper would otherwise never receive an identity.
      const cands = [...list.querySelectorAll('button')];
      const rows = cands.filter(c => !c.classList.contains('dsa-group-head'));
      const direct = [...list.children].filter(c => c.tagName === 'BUTTON');
      // Prefer DOM order (querySelectorAll is document order) and keep rows
      // that the shell renders directly under the list.
      const seen = new Set();
      const ordered = [];
      for (const c of direct.concat(rows)) {
        if (seen.has(c)) continue;
        seen.add(c);
        ordered.push(c);
      }
      ordered.forEach(c => {
        if (!c.getAttribute('data-dsa-id')) {
          // Row identity: the label span text is not stable; prefer React key —
          // not exposed. Use aria-current/a stable data attr? The rows carry no
          // id. Derive one from the label text (localized but stable per locale).
          const labelEl = c.querySelector('span:last-child');
          c.setAttribute('data-dsa-id', labelEl ? labelEl.textContent.trim() : c.textContent.trim());
        }
      });
    }

    // ---- bootstrap: watch for dialog mount --------------------------------
    let lastList = null;
    const boot = () => {
      injectCss();
      const list = findNavList();
      if (list && list !== lastList) {
        console.info('[dsh-settings-arranger] nav anchored:', list.children.length, 'children');
      }
      if (list !== lastList) {
        lastList = list;
        if (list) {
          ARRANGER.navList = list;
          list.classList.add('dsa-nav-list');
          list.setAttribute('data-dsa-anchored', '1');
          if (ARRANGER.editing) list.classList.add('dsa-editing');
          tagRows(list);
          ARRANGER.watch(list);
          ARRANGER.render();
          // Record the user's section choice (capture phase, so the shell
          // cannot swallow it). Only trusted clicks: our replay uses
          // element.click(). Own chrome ([data-dsa-own]: footer, head actions)
          // is not a section — clicking 新建分组 must not be remembered as one.
          list.addEventListener('click', e => {
            if (ARRANGER.editing || !e.isTrusted) return;
            const btn = e.target && e.target.closest ? e.target.closest('button[data-dsa-id]') : null;
            if (!btn || btn.closest('[data-dsa-own]')) return;
            if (!ARRANGER.navList || !ARRANGER.navList.contains(btn)) return;
            ARRANGER.recordLast(btn.getAttribute('data-dsa-id'));
          }, true);
          // Restore where the user left off (shell resets to its first row).
          if (!ARRANGER.editing) ARRANGER.scheduleReplay();
        }
        // If list is null (transient DOM state), keep ARRANGER.navList; the
        // next setEditing/render call re-anchors lazily via ensureNav().
      }
    };
    const mo = new MutationObserver(() => boot());
    mo.observe(document.body, { childList: true, subtree: true });
    boot();

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.action', () => ctx.slots.register({
          name: 'settings.action',
          id: 'dsh-settings-arranger',
          order: -1,
        }, ActionButton));
      },
    };
  },
});
