export function shouldRenderGlobalChatInput({
  projectId,
  taskPanelOpen,
  taskModeActive,
}: {
  projectId: string | null | undefined;
  taskPanelOpen: boolean;
  taskModeActive: boolean;
}): boolean {
  return Boolean(projectId) && !taskPanelOpen && !taskModeActive;
}
