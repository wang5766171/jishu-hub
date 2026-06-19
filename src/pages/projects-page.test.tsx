import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/types";
import { ProjectsPage } from "./projects-page";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/components/projects/project-card", () => ({
  ProjectCard: ({ project }: { project: Project }) => (
    <div data-testid="project-card">{project.name}</div>
  ),
}));
vi.mock("@/components/projects/project-detail", () => ({
  ProjectDetail: () => <div data-testid="project-detail" />,
}));
vi.mock("@/components/projects/add-project-dialog", () => ({
  AddProjectDialog: () => null,
}));
vi.mock("@/components/projects/merge-dialog", () => ({
  MergeDialog: () => null,
}));
vi.mock("@/agents", () => ({
  useAgent: () => ({ agents: [], activeId: "claude_code" }),
}));

const sampleProject = (name: string): Project => ({
  name,
  path: `/home/${name}`,
  encoded_name: name,
  session_count: 0,
  last_active: null,
  has_claude_md: false,
  agent_ids: [],
  initialized: false,
});

const noop = () => Promise.resolve([] as unknown[]);

describe("ProjectsPage (props-driven)", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({}); // get_project_merges
  });

  it("renders project cards immediately when projects are provided (no skeleton)", () => {
    render(
      <ProjectsPage
        projects={[sampleProject("alpha"), sampleProject("beta")]}
        projectMetas={null}
        refetchProjects={vi.fn()}
        refetchProjectMetas={noop}
      />,
    );
    expect(screen.getAllByTestId("project-card")).toHaveLength(2);
  });

  it("shows skeleton (no cards) while projects are not yet loaded (null)", () => {
    render(
      <ProjectsPage
        projects={null}
        projectMetas={null}
        refetchProjects={vi.fn()}
        refetchProjectMetas={noop}
      />,
    );
    expect(screen.queryByTestId("project-card")).toBeNull();
  });

  it("shows the empty-state placeholder when the project list is empty", async () => {
    render(
      <ProjectsPage
        projects={[]}
        projectMetas={null}
        refetchProjects={vi.fn()}
        refetchProjectMetas={noop}
      />,
    );
    expect(await screen.findByText(i18n.t("projects.noProjects"))).toBeInTheDocument();
  });

  it("calls refetchProjects when the refresh button is clicked", () => {
    const refetchProjects = vi.fn();
    render(
      <ProjectsPage
        projects={[sampleProject("alpha")]}
        projectMetas={null}
        refetchProjects={refetchProjects}
        refetchProjectMetas={noop}
      />,
    );
    fireEvent.click(screen.getByTitle(i18n.t("projects.refresh")));
    expect(refetchProjects).toHaveBeenCalled();
  });
});
