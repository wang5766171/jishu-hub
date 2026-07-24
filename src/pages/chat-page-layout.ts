export function shouldRenderGlobalChatInput({
  projectId,
  taskModeActive,
}: {
  projectId: string | null | undefined;
  taskModeActive: boolean;
}): boolean {
  return Boolean(projectId) && !taskModeActive;
}
