import { useState, useEffect } from "react";
import { Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { invokeCommand } from "@/hooks/use-invoke";
import { cn } from "@/lib/utils";

export function TitleBar() {
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    invokeCommand<boolean>("load_always_on_top").then(setPinned).catch(console.error);
  }, []);

  const handleToggle = async () => {
    try {
      const newValue = await invokeCommand<boolean>("toggle_always_on_top");
      setPinned(newValue);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="flex items-center h-8 border-b bg-background px-3">
      <div className="flex-1 text-xs text-muted-foreground">
        Jishu Hub
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={handleToggle}
        className={cn("h-6 w-6", pinned && "text-primary")}
        title={pinned ? "取消置顶" : "置顶窗口"}
      >
        {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
