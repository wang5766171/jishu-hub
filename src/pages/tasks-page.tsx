import { TaskWorkbench } from "@/features/task-workbench";

export interface TasksPageProps {
  initialProjectPath?: string | null;
  initialGraphId?: string | null;
  initialPlanInstruction?: string | null;
  onClose?: () => void;
}

export function TasksPage(props: TasksPageProps) {
  return (
    <div className="flex h-full w-full bg-background overflow-hidden">
      <TaskWorkbench
        initialProjectPath={props.initialProjectPath}
        initialGraphId={props.initialGraphId}
        initialPlanInstruction={props.initialPlanInstruction}
        onClose={props.onClose}
      />
    </div>
  );
}
