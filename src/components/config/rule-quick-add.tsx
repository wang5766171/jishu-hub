// v0.7.4 需求2 R2b：权限规则快捷添加（allow/deny 列表上方按钮组）。
// 常用规则一键追加（去重），保留手写输入；规则语法为 Claude Code
// 权限规则（Bash(cmd:*) 前缀匹配、Read/Edit 路径匹配）。

import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

export const QUICK_RULES = [
  { pattern: "Bash(git:*)", labelKey: "config.rule.git" },
  { pattern: "Bash(npm:*)", labelKey: "config.rule.npm" },
  { pattern: "Bash(pnpm:*)", labelKey: "config.rule.pnpm" },
  { pattern: "Read(**)", labelKey: "config.rule.read" },
  { pattern: "Edit(**)", labelKey: "config.rule.edit" },
] as const;

export function RuleQuickAdd({
  patterns,
  onAdd,
}: {
  /** 当前列表（去重判断用） */
  patterns: string[];
  onAdd: (pattern: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground/80">
        {t("config.rule.quickAdd")}
      </span>
      {QUICK_RULES.map((rule) => {
        const exists = patterns.includes(rule.pattern);
        return (
          <Button
            key={rule.pattern}
            type="button"
            size="sm"
            variant={exists ? "ghost" : "outline"}
            disabled={exists}
            className="h-6 px-2 text-[11px]"
            onClick={() => onAdd(rule.pattern)}
            title={rule.pattern}
          >
            {!exists && <Plus className="mr-1 h-3 w-3" />}
            {t(rule.labelKey)}
          </Button>
        );
      })}
    </div>
  );
}
