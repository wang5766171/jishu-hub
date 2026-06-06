import re

with open("src/pages/tasks-page.tsx", "r", encoding="utf-8") as f:
    c = f.read()

c = c.replace("interface RunSummary", "export interface RunSummary")
c = c.replace("interface RunRecord", "export interface RunRecord")

# Remove statusVariant
c = re.sub(r'function statusVariant\(.*?\).*?return "secondary";\n}', '', c, flags=re.DOTALL)

# Add imports
c = 'import { TaskRunsList, statusVariant } from "@/components/tasks/TaskRunsList";\n' + c

# Replace the block
block_to_replace = r'''<div className="space-y-3 rounded-lg border bg-card p-4">\s*<div className="flex items-center justify-between">\s*<h3 className="text-sm font-semibold">{t\("tasks\.runs"\)}</h3>\s*<Badge variant="secondary">{runs\.length}</Badge>\s*</div>\s*<div className="space-y-2">\s*{runs\.length === 0 \? \(\s*<div className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">\s*{loading \? t\("tasks\.loadingRuns"\) : t\("tasks\.noRuns"\)}\s*</div>\s*\) : \(\s*runs\.slice\(0, 12\)\.map\(\(run\) => \(\s*<button\s*key={run\.run_id}\s*onClick={\(\) => loadRun\(run\.run_id\)}\s*onContextMenu={\(e\) => {\s*e\.preventDefault\(\);\s*setContextMenu\({ runId: run\.run_id, x: e\.clientX, y: e\.clientY }\);\s*}}\s*className={`w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent/40 \${\s*selectedRun\?\.run_id === run\.run_id\s*\? "bg-accent/60 border-primary"\s*: "bg-background/60"\s*}`}\s*>\s*<div className="flex items-center justify-between gap-2">\s*<span className="truncate text-sm font-medium">{run\.title \|\| run\.task_id}</span>\s*<Badge variant={statusVariant\(run\.status\)}>{translateStatus\(run\.status\)}</Badge>\s*</div>\s*<div className="mt-1 truncate text-xs text-muted-foreground">{run\.run_id}</div>\s*</button>\s*\)\)\s*\)\}\s*</div>\s*</div>'''

replacement = r'''<TaskRunsList
          runs={runs}
          loading={loading}
          selectedRun={selectedRun}
          loadRun={loadRun}
          onContextMenu={(e, runId) => {
            e.preventDefault();
            setContextMenu({ runId, x: e.clientX, y: e.clientY });
          }}
        />'''

c = re.sub(block_to_replace, replacement, c, count=1)

with open("src/pages/tasks-page.tsx", "w", encoding="utf-8") as f:
    f.write(c)

print("Done")
