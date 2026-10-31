/**
 * 混合插件运行时（v0.9.3 需求25 P1）：@file: 代码组件的加载、注册与隔离。
 *
 * 加载机制（01-分析与设计 §二）：经典 <script> 标签 + 全局注册——插件代码文件
 * 无 import/无 JSX，经 Tauri 资产协议（scope 限定 ~/.jishu-hub/plugins/**，
 * CSP script-src 已放行 asset 源）注入，尾调 JishuPlugin.register(id, factory)。
 * 文件内容指纹作 query 参数实现热更（指纹变化 → 重注入取新版本）。
 *
 * API v1（PLUGIN_API_VERSION=1）：factory(api) 返回组件构造；api 注入
 * h（React.createElement 绑定）/五个常用钩子/t（i18n）/cn——**刻意不提供**
 * IPC 与任意导入（白名单纪律，后续按需单项评审开放）。
 */
import {
  Component,
  createElement,
  useCallback,
  useMemo,
  useRef,
  useState,
  useEffect,
  type ComponentType,
  type ReactNode,
} from "react";
import i18next from "i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { setErrorSuppression } from "@/lib/error-suppression";

/** 资产 URL 构建（可注入——vitest 无 Tauri 内部注入时走测试替身）。
 *  路径归一：Rust _dir 在 Windows 是反斜杠（C:\Users\...），asset 协议
 *  scope 用正斜杠——混合分隔符路径 scope 匹配不上，脚本加载静默失败
 *  （用户实测：插件中心可见但能力中心无面板）。统一转正斜杠再喂
 *  convertFileSrc。 */
let buildAssetUrl: (dir: string, rel: string) => string = (dir, rel) =>
  convertFileSrc(`${dir.replace(/\\/g, "/")}/${rel}`);

/** 测试口：替换资产 URL 构建器。 */
export function setAssetUrlBuilderForTest(builder: (dir: string, rel: string) => string): void {
  buildAssetUrl = builder;
}

/** 脚本注入缝（默认 document.head 注入；测试用替身避免 jsdom 外联即 onerror）。 */
let injectScriptElement: (url: string, onerror: () => void) => void = (url, onerror) => {
  const script = document.createElement("script");
  script.src = url;
  script.async = true;
  script.onerror = onerror;
  document.head.appendChild(script);
};

/** 测试口：替换脚本注入器。 */
export function setScriptInjectorForTest(injector: (url: string, onerror: () => void) => void): void {
  injectScriptElement = injector;
}

/** 库脚本注入缝（loadAsset script 类用；onload/onerror Promise 化——
 *  库文件不调 JishuPlugin.register，不能复用注册等待机制）。 */
let injectLibraryScript: (url: string) => Promise<void> = (url) =>
  new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`库脚本加载失败: ${url}`));
    document.head.appendChild(script);
  });

/** 测试口：替换库脚本注入器。 */
export function setLibraryScriptInjectorForTest(injector: (url: string) => Promise<void>): void {
  injectLibraryScript = injector;
}

/** 混合代码契约版本；hub 升级保证兼容或给出明确迁移错误。
 *  bump 判据（1e 同 SESSION_PLUGIN_CONTRACT_VERSION）：纯加法（新可选
 *  API/props 字段）不 bump；注入 API 签名变化/删除/语义变更必须 bump，
 *  且旧版本 component.js 装载时给出明确迁移错误。 */
export const PLUGIN_API_VERSION = 1;

/** 注入给插件 factory 的 API 面（v1）。 */
export interface HybridPluginApi {
  h: typeof createElement;
  useState: typeof useState;
  useEffect: typeof useEffect;
  useMemo: typeof useMemo;
  useRef: typeof useRef;
  useCallback: typeof useCallback;
  t: (key: string, fallback?: string) => string;
  cn: typeof cn;
  /** 需求14 M1（02 §3.2，v1 纯加法不 bump）：加载插件目录内资产。
   *  - rel：相对插件根目录的文件名（必须平铺——_files 是浅层扫描，B3）；
   *    拒绝 `..`/绝对路径/反斜杠/盘符等越界形态。
   *  - kind：script = 注入 `<script>` 并等待 onload（模块级缓存——同一库
   *    多代码块实例只加载一次，内容指纹变才重注）；url/style = 仅返回
   *    asset 协议 URL（style-src CSP 无 asset 源，样式注入走 M2 主题装载
   *    器，此处不做 `<link>`）。
   *  - 存在性以 Rust 注入的 `_files` 指纹清单为白名单。 */
  loadAsset?: (rel: string, kind?: "script" | "style" | "url") => Promise<string>;
}

/** loadAsset 的插件目录上下文（_dir 基址 + _files 指纹白名单）。 */
interface PluginAssetScope {
  dir: string;
  files: Record<string, string>;
}

/** 模块级库脚本缓存（R4，性能关键）：URL（含内容指纹 ?v=）→ 加载 Promise。
 *  同一库只注入一次、多代码块实例共享；失败不缓存（下次可重试）。 */
const libraryScripts = new Map<string, Promise<void>>();

function loadLibraryScript(url: string): Promise<void> {
  let pending = libraryScripts.get(url);
  if (!pending) {
    pending = injectLibraryScript(url);
    libraryScripts.set(url, pending);
    pending.catch(() => libraryScripts.delete(url));
  }
  return pending;
}

/** 测试口：清空库脚本缓存。 */
export function clearLibraryScriptCacheForTest(): void {
  libraryScripts.clear();
}

async function loadPluginAsset(
  scope: PluginAssetScope,
  rel: string,
  kind?: "script" | "style" | "url",
): Promise<string> {
  const normalized = rel.trim();
  if (
    !normalized ||
    normalized.includes("..") ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    throw new Error(`loadAsset: 非法资产路径 ${rel}（仅限插件目录内相对路径）`);
  }
  const fingerprint = scope.files[normalized];
  if (!fingerprint) {
    throw new Error(
      `loadAsset: 资产 ${rel} 不在插件文件清单——资产必须平铺在插件根目录（子目录不入 _files 白名单）`,
    );
  }
  const url = `${buildAssetUrl(scope.dir, normalized)}?v=${fingerprint}`;
  if (kind === "script") await loadLibraryScript(url);
  return url;
}

/** 插件代码注册的 factory 形状。组件 props 与组合渲染组件同构
 *  （payload/options/actions）。 */
export interface HybridPluginFactory {
  version: number;
  component: (api: HybridPluginApi) => ComponentType<Record<string, unknown>>;
}

interface GlobalRegistrar {
  register(pluginId: string, factory: HybridPluginFactory): void;
}

type GlobalWithRegistrar = typeof globalThis & {
  JishuPlugin?: GlobalRegistrar & {
    register(arg1: string | HybridPluginFactory, arg2?: HybridPluginFactory): void;
  };
};

function ensureGlobal(): GlobalRegistrar {
  const g = globalThis as GlobalWithRegistrar;
  if (!g.JishuPlugin) {
    g.JishuPlugin = {
      register(arg1: string | HybridPluginFactory, arg2?: HybridPluginFactory) {
        // 兼容两种调用形态：register(id, factory) 与 register(factory)
        // （单参数时 factory 作为 arg1 传入——用户实测踩坑：测试清单示例
        // 写了单参数形态导致 pluginId 匹配不上、2s 超时报"未注册"）。
        // 单参数时不知道自己的 id——存入"匿名"槽，由 pending 遍历匹配。
        let pluginId: string;
        let factory: HybridPluginFactory;
        if (typeof arg1 === "string" && arg2) {
          pluginId = arg1;
          factory = arg2;
        } else if (typeof arg1 === "object" && arg1 !== null && "version" in arg1) {
          // 单参数形态：factory 对象作为 arg1。此时不知道插件 id——
          // 查找唯一 pending（只有一个插件在等待时可靠）。
          factory = arg1 as HybridPluginFactory;
          const pendingIds = [...pendingRegistrations.keys()];
          pluginId = pendingIds.length === 1 ? pendingIds[0] : "";
          if (!pluginId) {
            console.warn("[hybrid] 单参数 register 但无唯一待注册插件（多插件并发或无 pending），注册被忽略");
            return;
          }
        } else {
          console.warn("[hybrid] register 参数形态不合法（需要 (id, factory) 或 (factory)）");
          return;
        }
        // 恒存注册体（同指纹复用时免重注入读取）。
        registrations.set(pluginId, factory);
        const pending = pendingRegistrations.get(pluginId);
        if (pending) {
          pendingRegistrations.delete(pluginId);
          pending(factory);
        }
        // 无 pending：脚本重注入竞态（旧脚本晚到），仅更新注册体即可。
      },
    };
  }
  return g.JishuPlugin;
}

const pendingRegistrations = new Map<string, (factory: HybridPluginFactory) => void>();
const registrations = new Map<string, HybridPluginFactory>();
/** 已注入脚本的指纹（插件 id → fingerprint）：变更才重注入。 */
const loadedFingerprints = new Map<string, string>();

/** 测试口：确保全局注册器就位并清空当次状态（仅单测使用）。 */
export function ensureGlobalRegisterForTest(): GlobalRegistrar {
  const registrar = ensureGlobal();
  pendingRegistrations.clear();
  registrations.clear();
  loadedFingerprints.clear();
  return registrar;
}

function buildApi(assetScope?: PluginAssetScope): HybridPluginApi {
  return {
    h: createElement,
    useState,
    useEffect,
    useMemo,
    useRef,
    useCallback,
    t: (key, fallback) => i18next.t(key, { defaultValue: fallback }),
    cn,
    // loadAsset 仅对有目录上下文的混合插件注入（@file: 组件装载链路必带
    //_dir/_files；防御性可选——测试替身/异常形态下不炸）。
    ...(assetScope
      ? {
          loadAsset: (rel: string, kind?: "script" | "style" | "url") =>
            loadPluginAsset(assetScope, rel, kind),
        }
      : {}),
  };
}

/** factory 契约校验：版本匹配 + component 为函数；不匹配给明确错误。 */
export function validateFactory(pluginId: string, factory: HybridPluginFactory): string | null {
  if (!factory || typeof factory !== "object") return `${pluginId}: 注册体不是对象`;
  if (factory.version !== PLUGIN_API_VERSION) {
    return `${pluginId}: 插件 API 版本不匹配（插件 ${factory.version}，hub ${PLUGIN_API_VERSION}）——请按当前版本规范改写`;
  }
  if (typeof factory.component !== "function") return `${pluginId}: component 不是函数`;
  return null;
}

/**
 * 加载（或按指纹热更）插件的代码组件。
 * 失败形态返回 Error（调用方决定跳过/标记），不抛出。
 *
 * 全局错误抑制窗口：注入脚本期间打开（脚本语法/执行错误由本函数的
 * 超时/onerror 机制优雅处理），全局 window.onerror 处理器看到窗口
 * 开着就跳过——不会炸掉整页（用户实测 1.5 改坏代码后整页白屏的教训）。
 * 窗口在脚本加载完成/失败/超时后关闭。
 */
export async function loadHybridComponent(
  pluginId: string,
  dir: string,
  relFile: string,
  fingerprint: string,
  files?: Record<string, string>,
): Promise<ComponentType<Record<string, unknown>> | Error> {
  ensureGlobal();
  // 需求14 M1：_files 白名单随装载链传入——api.loadAsset 的资产基址与
  //存在性校验据此构建（无 files 时不注入 loadAsset，旧调用形态不受影响）。
  const assetScope = files ? { dir, files } : undefined;
  // 打开全局错误抑制窗口（具体处理器优先于兜底——用户架构裁决）。
  setErrorSuppression(true);
  // 热更：指纹变化 → 移除旧脚本重新注入；未变化直接复用注册结果。
  if (loadedFingerprints.get(pluginId) === fingerprint) {
    const cached = registrations.get(pluginId);
    if (cached) {
      const invalid = validateFactory(pluginId, cached);
      return invalid ? new Error(invalid) : cached.component(buildApi(assetScope));
    }
  }
  loadedFingerprints.set(pluginId, fingerprint);
  registrations.delete(pluginId);

  const url = `${buildAssetUrl(dir, relFile)}?v=${fingerprint}`;
  const factory = await new Promise<HybridPluginFactory | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        pendingRegistrations.delete(pluginId);
        resolve(null);
      }
    }, 2000);
    pendingRegistrations.set(pluginId, (f) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(f);
    });
    injectScriptElement(url, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingRegistrations.delete(pluginId);
      resolve(null);
    });
  });

  if (!factory) {
    setErrorSuppression(false);
    return new Error(
      `${pluginId}: 代码文件加载失败（不存在/语法错误/2 秒内未注册）——检查 ${relFile} 是否以 JishuPlugin.register(...) 结尾`,
    );
  }
  const invalid = validateFactory(pluginId, factory);
  if (invalid) {
    setErrorSuppression(false);
    return new Error(invalid);
  }
  const component = factory.component(buildApi(assetScope));
  setErrorSuppression(false);
  return component;
}

// ── 崩溃隔离（P1）：混合组件渲染包裹 ErrorBoundary，异常回调宿主自动停用 ──

let onError: ((pluginId: string, error: unknown) => void) | null = null;

/** 宿主注册崩溃回调（loader 接：自动停用 + 通知）。 */
export function setHybridErrorHandler(handler: (pluginId: string, error: unknown) => void): void {
  onError = handler;
}

interface BoundaryProps {
  pluginId: string;
  children: ReactNode;
  /** 需求14 M1（B1）：崩溃时的兜底渲染（manifest 声明的 fallback 键组件）。
   *  缺省维持旧行为（崩溃即卸载不占位）；onError 自动停用链路不受影响。 */
  fallback?: ReactNode;
}

interface BoundaryState {
  error: Error | null;
}

export class HybridErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    onError?.(this.props.pluginId, error);
  }

  render(): ReactNode {
    if (this.state.error) {
      // 崩溃即卸载渲染（宿主已收到回调停用整插件），不占位扰民；
      // 声明了 fallback（B1）则以兜底渲染占位（如源码视图），会话不空白。
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
