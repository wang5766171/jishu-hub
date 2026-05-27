import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import type { CustomCommand } from "@/types";

interface AddCommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editCommand?: CustomCommand | null;
  agentId: string | null;
  onSaved: () => void;
}

export function AddCommandDialog({ open, onOpenChange, editCommand, agentId, onSaved }: AddCommandDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(editCommand?.name ?? "");
      setCommand(editCommand?.command ?? "");
      setProjectPath(editCommand?.projectPath ?? "");
    }
  }, [open, editCommand]);

  const handleSave = async () => {
    if (!name.trim() || !command.trim()) return;
    setSaving(true);
    try {
      const cmd: CustomCommand = {
        id: editCommand?.id ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: name.trim(),
        command: command.trim(),
        agentId,
        projectPath: projectPath.trim() || null,
      };
      await invokeCommand("save_custom_command", { cmd });
      onSaved();
      onOpenChange(false);
      if (!editCommand) {
        setName("");
        setCommand("");
        setProjectPath("");
      }
    } catch (err) {
      console.error("Failed to save command:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editCommand ? t("commands.editCommand") : t("commands.addCommand")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="cmd-name">{t("commands.commandName")}</Label>
            <Input
              id="cmd-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("commands.commandNamePlaceholder")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd-string">{t("commands.commandString")}</Label>
            <Input
              id="cmd-string"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("commands.commandStringPlaceholder")}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd-path">{t("commands.projectPath")}</Label>
            <Input
              id="cmd-path"
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder={t("commands.projectPathPlaceholder")}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || !command.trim() || saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
