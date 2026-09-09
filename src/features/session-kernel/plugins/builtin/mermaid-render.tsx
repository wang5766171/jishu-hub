import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SESSION_PLUGIN_CONTRACT_VERSION } from "../types";
import type { SessionPluginDescriptor } from "../types";

/**
 * Mermaid/图表渲染插件（v0.9.2 需求1 M4，用户圈定首期 #2）。
 * mermaid 代码块 → SVG 图形；渲染失败回退源码显示（fail-soft）。
 * mermaid 按需动态 import（体积大，不进主包），securityLevel=strict
 * （默认，转义脚本注入面）。
 */

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;

async function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => {
      mod.default.initialize({ startOnLoad: false, securityLevel: "strict" });
      return mod.default;
    });
  }
  return mermaidReady;
}

function MermaidDiagram({ code }: { code: string; language: string }) {
  const { t } = useTranslation();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`mmd-${useId().replace(/[^a-zA-Z0-9]/g, "")}`);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setSvg(null);
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const { svg } = await mermaid.render(idRef.current, code);
        if (!cancelled) setSvg(svg);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) {
    return (
      <pre className="my-2 overflow-auto rounded-lg border border-border/60 p-2 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <div className="my-2 overflow-x-auto rounded-lg border border-border/60 bg-muted/20 p-2">
      {svg ? (
        <div
          className="mermaid-svg-host [&_svg]:mx-auto [&_svg]:max-h-[520px]"
          // mermaid securityLevel=strict 产物已转义脚本注入面
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="py-6 text-center text-xs text-muted-foreground">
          {t("sessionPlugins.mermaidRender.rendering", "图表渲染中…")}
        </div>
      )}
    </div>
  );
}

export const mermaidRenderPlugin: SessionPluginDescriptor = {
  id: "session.mermaid-render",
  displayNameKey: "sessionPlugins.mermaidRender.name",
  displayNameFallback: "Mermaid 图表渲染",
  descriptionKey: "sessionPlugins.mermaidRender.description",
  descriptionFallback: "流程图/时序图等 mermaid 代码块渲染为图形",
  contractVersion: SESSION_PLUGIN_CONTRACT_VERSION,
  source: "builtin",
  permissions: ["read:blocks"],
  mounts: [
    {
      kind: "block-renderer",
      languages: ["mermaid", "mmd"],
      detect: () => true,
      Component: MermaidDiagram,
    },
  ],
};
