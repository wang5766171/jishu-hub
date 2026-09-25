/**
 * 混合插件 component.js 代码校验（v0.9.5 需求1（原需求26）2a）。
 *
 * 校验分层（01 §二设计）：
 * - **语法检查**（编辑器实时）：acorn 解析——错误行号+列+原因；
 * - **契约检查**（保存前）：AST 遍历找 `JishuPlugin.register(id, factory)`
 *   调用——两参数形态、factory 形状（version 字面量 === PLUGIN_API_VERSION、
 *   component 为函数）；
 * - 运行时预览与装载验证不在本模块（2b / 已有 P1 装载链）。
 */
import * as acorn from "acorn";
import { PLUGIN_API_VERSION } from "./hybrid-runtime";

interface SimpleNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface SyntaxIssue {
  line: number;
  col: number;
  message: string;
}

export interface CodeValidation {
  /** 语法错误（空 = 语法通过）。 */
  syntax: SyntaxIssue[];
  /** 契约错误（register 形状 / version / component——空 = 契约通过）。 */
  contract: string[];
  valid: boolean;
}

/** 校验 component.js 源码。pluginId 可选——提供时校验 register 第一参一致。 */
export function validateComponentJs(
  source: string,
  opts?: { pluginId?: string },
): CodeValidation {
  const syntax: SyntaxIssue[] = [];
  const contract: string[] = [];

  // ── 语法层：acorn 解析 ──
  let ast: acorn.Program | null = null;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      locations: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    const err = error as { message?: string; loc?: { line: number; column: number } };
    syntax.push({
      line: err.loc?.line ?? 1,
      col: (err.loc?.column ?? 0) + 1,
      message: String(err.message ?? "语法错误"),
    });
    // 语法都不过，契约层无从谈起。
    return { syntax, contract, valid: false };
  }

  // ── 契约层：AST 遍历找 JishuPlugin.register 调用 ──
  const registers: Array<{
    args: SimpleNode[];
    line: number;
  }> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as SimpleNode;
    if (n.type === "CallExpression") {
      const callee = n.callee as SimpleNode | undefined;
      const obj = callee?.object as SimpleNode | undefined;
      const prop = callee?.property as SimpleNode | undefined;
      const isRegister =
        callee?.type === "MemberExpression" &&
        obj?.type === "Identifier" &&
        (obj as { name?: string }).name === "JishuPlugin" &&
        prop?.type === "Identifier" &&
        (prop as { name?: string }).name === "register" &&
        !(callee as { computed?: boolean }).computed;
      if (isRegister) {
        registers.push({
          args: (n.arguments ?? []) as SimpleNode[],
          line: (n as { loc?: { line: number } }).loc?.line ?? 1,
        });
      }
    }
    for (const key of Object.keys(n)) {
      if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
      const value = (n as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) walk(child);
      } else if (value && typeof value === "object") {
        walk(value);
      }
    }
  };
  walk(ast);

  if (registers.length === 0) {
    contract.push('缺少 "JishuPlugin.register(...)" 注册调用（代码契约）');
  }
  for (const reg of registers) {
    if (reg.args.length === 2) {
      // 两参数形态（推荐）：register(id, factory)。
      const idNode = reg.args[0];
      if (idNode.type !== "Literal" || typeof (idNode as { value?: unknown }).value !== "string") {
        contract.push(`第 ${reg.line} 行：register 第一参数应为插件 id 字符串字面量`);
      } else if (opts?.pluginId && ((idNode as unknown) as { value: string }).value !== opts.pluginId) {
        contract.push(
          `第 ${reg.line} 行：register id "${((idNode as unknown) as { value: string }).value}" 与清单 plugin.id "${opts.pluginId}" 不一致`,
        );
      }
      checkFactory(reg.args[1], reg.line, contract);
    } else if (reg.args.length === 1) {
      // 单参数形态：兼容但不推荐（匿名槽匹配）。
      contract.push(
        `第 ${reg.line} 行：register 建议用两参数形态 register(id, factory)（单参数依赖匿名槽匹配，不推荐）`,
      );
      checkFactory(reg.args[0], reg.line, contract);
    } else {
      contract.push(`第 ${reg.line} 行：register 参数个数异常（期望 1~2 个，实际 ${reg.args.length}）`);
    }
  }

  return { syntax, contract, valid: syntax.length === 0 && contract.length === 0 };
}

/** factory 对象形状：version 字面量 === 当前 PLUGIN_API_VERSION + component 函数。 */
function checkFactory(factoryNode: unknown, line: number, contract: string[]): void {
  const node = factoryNode as SimpleNode | undefined;
  if (!node || node.type !== "ObjectExpression") {
    contract.push(`第 ${line} 行：register 的 factory 参数应为对象字面量 { version, component }`);
    return;
  }
  const props = (node.properties ?? []) as Array<SimpleNode & { key?: SimpleNode & { name?: string }; value?: SimpleNode }>;
  const findProp = (name: string): SimpleNode | undefined =>
    props.find(
      (p) => p.key?.type === "Identifier" && p.key.name === name,
    )?.value;
  const version = findProp("version");
  if (!version) {
    contract.push(`第 ${line} 行：factory 缺少 "version" 字段（当前 PLUGIN_API_VERSION = ${PLUGIN_API_VERSION}）`);
  } else if (version.type !== "Literal" || (version as { value?: unknown }).value !== PLUGIN_API_VERSION) {
    contract.push(
      `第 ${line} 行：version 应为字面量 ${PLUGIN_API_VERSION}（当前 PLUGIN_API_VERSION；hub 升级保证兼容或给出迁移错误）`,
    );
  }
  const component = findProp("component");
  if (!component) {
    contract.push(`第 ${line} 行：factory 缺少 "component" 字段（组件构造函数）`);
  } else if (component.type !== "FunctionExpression" && component.type !== "ArrowFunctionExpression") {
    contract.push(`第 ${line} 行："component" 应为函数（(api) => (props) => vnode）`);
  }
}
