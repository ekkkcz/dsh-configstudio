/**
 * ConfigStudio —— DSH 浏览器半边。
 *
 * 这段代码由 DSH 的 client-modules 在浏览器里通过 window.__ModuleLoader__ 加载。
 * 约束（依据 DSH 0.1.6-alpha.2 源码核查，见 docs/dsh-integration.md）：
 *  - 只能 require 平台白名单里的模块：react / react-dom / @deepseek-ai/cordis /
 *    dsh-client-store / dsh-client-ui-slots / dsh-client-ui-primitives / dsh-client-ui-dockkit。
 *  - 这里只 require('react')：它在 seed 表里，绝对安全，不依赖 dsh.client.inject 的到达顺序。
 *  - 宿主不会替外部包构建前端产物，所以这个文件是手写的闭包工厂（与
 *    dsh-prompt-optimizer 的形态一致）。
 *
 * 设计取舍：DSH 侧只挂"一个侧栏入口 + 一个整页"，整页用 iframe 指向我们自己
 * 路由提供的 SPA。这样对 DSH 内部插槽契约的依赖压到最小：插槽 API 变了最多是
 * 入口找不到，页面本体（纯 HTTP + 静态资源）不受影响。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/configstudio',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    const NS = 'configstudio';
    const API = '/configstudio/api';
    const PAGE_PATH = '/configstudio/api/ui';

    /**
     * 单例闸门：HMR 会重新求值本包，旧实例的插槽注册若尚未回收就会出现
     * 新旧并存（两个入口、重复渲染）。只有持有 token 的实例才有权注册。
     * 与 dsh-prompt-optimizer 同一写法。
     */
    const INSTANCE_TOKEN = NS + '#' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const isActiveInstance = () => {
      try { return window.__HTML_ARENA_ACTIVE__ === INSTANCE_TOKEN; } catch { return true; }
    };

    const PANEL_ID = 'configstudio';

    /**
     * 整页组件：一个全高 iframe 指向我们自己的 SPA。
     * 用 iframe 而不是直接在 React 里渲染整页，是为了让 SPA 完全运行在我们自己的
     * 路由与刷新周期里——DSH 前端升级不会牵动页面内部实现。
     */
    function ArenaPage() {
      return React.createElement('iframe', {
        src: PAGE_PATH,
        title: 'ConfigStudio',
        style: {
          width: '100%',
          height: '100%',
          border: '0',
          display: 'block',
          background: 'transparent',
        },
      });
    }

    /** 侧栏入口图标：一个极简的并排双栏字形，不引入任何图标依赖。 */
    function ArenaIcon() {
      return React.createElement('span', {
        'aria-hidden': 'true',
        style: {
          display: 'inline-block', width: '16px', height: '16px', lineHeight: 0,
          position: 'relative',
        },
      }, React.createElement('span', {
        style: {
          position: 'absolute', inset: '1px 8.5px 1px 1px',
          border: '1.5px solid currentColor', borderRadius: '2px',
        },
      }), React.createElement('span', {
        style: {
          position: 'absolute', inset: '1px 1px 1px 8.5px',
          border: '1.5px solid currentColor', borderRadius: '2px',
        },
      }));
    }

    exports.name = NS;

    exports.apply = function apply(ctx) {
      try { window.__HTML_ARENA_ACTIVE__ = INSTANCE_TOKEN; } catch { /* 忽略 */ }
      if (!isActiveInstance()) return;

      const disposers = [];

      // 整页注册：'main' 是 ui-layout 声明的 keyed 插槽。
      // 同 key 同优先级重复注册会抛错，所以先判断再注册，并且把 dispose 收好。
      try {
        const disposeMain = ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          children: {},
        }, ArenaPage));
        if (typeof disposeMain === 'function') disposers.push(disposeMain);
      } catch (err) {
        // 注册失败不能让整个 DSH 前端崩掉；把原因留在控制台便于诊断。
        console.warn('[configstudio] 整页注册失败，ConfigStudio 入口不可用：', err && err.message ? err.message : err);
      }

      // 侧栏入口
      try {
        const disposeSidebar = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: () => '配置对比',
          locale: NS,
          icon: ArenaIcon,
        }, ArenaIcon));
        if (typeof disposeSidebar === 'function') disposers.push(disposeSidebar);
      } catch (err) {
        console.warn('[configstudio] 侧栏入口注册失败：', err && err.message ? err.message : err);
      }

      // 让用户能一键打开（整页 iframe 之外的兜底入口）
      exports.open = () => {
        try { ctx.layout.selectPanel(PANEL_ID); return true; } catch { return false; }
      };
      exports.dispose = () => {
        for (const d of disposers) { try { d(); } catch { /* 已释放 */ } }
        disposers.length = 0;
      };

      // 自检输出：确认宿主路由真的在（而不是只挂上了空壳界面）
      fetch(API + '/meta').then((r) => r.json()).then((meta) => {
        console.info('[configstudio] 就绪：预览源 ' + meta.previewOrigin
          + '，浏览器能力 ' + (meta.browser?.available ? '可用' : '不可用（截图会标注未检查）'));
      }).catch(() => {
        console.warn('[configstudio] 宿主 API 不可达：' + API + '/meta。界面会显示连接失败而不是空白。');
      });
    };

    // DSH 的 'slots' 服务是我们唯一依赖的宿主能力（整页与侧栏入口）。
    exports.inject = ['slots'];

    return module.exports;
  },
});
