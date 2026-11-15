import * as React from "react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmDialogOptions {
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 确认按钮样式：destructive 用于不可逆/破坏性操作 */
  variant?: "default" | "destructive";
}

export interface AlertDialogOptions {
  title: string;
  description?: React.ReactNode;
  closeText?: string;
}

interface DialogState {
  open: boolean;
  mode: "confirm" | "alert";
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  closeText?: string;
  variant?: "default" | "destructive";
  resolve?: (ok: boolean) => void;
}

const INITIAL: DialogState = { open: false, mode: "confirm", title: "" };

/**
 * 可复用的应用内确认/提示弹窗，替代系统原生 confirm/message（样式与应用统一）。
 *
 * 返回 Promise，可在 async 流程中 await：
 *   const { confirm, alert, dialogNode } = useConfirmDialog();
 *   const ok = await confirm({ title, description });
 *   await alert({ title, description });
 *   // 并在 JSX 中渲染 {dialogNode}
 *
 * confirm：双按钮（取消/确认），resolve boolean。
 * alert：单按钮（知道了），resolve void。
 * 点遮罩/按 Esc 视为取消（confirm→false，alert→resolve）。
 */
export function useConfirmDialog() {
  const [state, setState] = useState<DialogState>(INITIAL);
  // 第五轮评审 P2-2：三个按钮默认值此前硬编码中文（取消/确定/知道了）——
  // 不传文案的调用方（组合件卸载确认等）英文态全部泄漏中文。默认值统一
  // 走 i18n（common.cancel/common.confirm/common.gotIt 双侧登记）。
  const { t } = useTranslation();

  const close = useCallback((ok: boolean) => {
    setState((prev) => {
      prev.resolve?.(ok);
      return INITIAL;
    });
  }, []);

  const confirm = useCallback(
    (opts: ConfirmDialogOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ ...opts, open: true, mode: "confirm", resolve });
      }),
    [],
  );

  const alert = useCallback(
    (opts: AlertDialogOptions) =>
      new Promise<void>((resolve) => {
        setState({ ...opts, open: true, mode: "alert", resolve: () => resolve() });
      }),
    [],
  );

  const dialogNode = (
    <Dialog
      open={state.open}
      onOpenChange={(open) => {
        if (!open) close(false);
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>{state.title}</DialogTitle>
          {state.description != null && (
            <DialogDescription className="whitespace-pre-line text-left">
              {state.description}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          {state.mode === "confirm" && (
            <Button variant="outline" onClick={() => close(false)}>
              {state.cancelText ?? t("common.cancel", "取消")}
            </Button>
          )}
          <Button
            variant={state.variant === "destructive" ? "destructive" : "default"}
            onClick={() => close(true)}
          >
            {state.mode === "alert"
              ? (state.closeText ?? t("common.gotIt", "知道了"))
              : (state.confirmText ?? t("common.confirm", "确定"))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, alert, dialogNode };
}
