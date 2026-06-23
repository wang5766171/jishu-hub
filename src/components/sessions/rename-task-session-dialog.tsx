import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "react-i18next";

// 任务会话重命名弹窗：纯 UI 组件，提交逻辑由父组件通过 onSubmit 注入，
// 避免依赖 page 层的 TaskLaunchInstanceSummary 类型（保持 components 不依赖 pages）。
// 复用 rename-session-dialog 的视觉样式，去掉 sessionId/删除别名等普通会话专属逻辑。
interface RenameTaskSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
  onSubmit: (name: string) => Promise<void>;
}

export function RenameTaskSessionDialog({ open, onOpenChange, currentName, onSubmit }: RenameTaskSessionDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(currentName);

  useEffect(() => {
    setName(currentName);
  }, [currentName, open]);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await onSubmit(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("sessions.renameTitle")}</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <Input
            placeholder={t("sessions.renamePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button onClick={handleSubmit}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
