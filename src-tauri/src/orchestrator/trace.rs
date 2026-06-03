use crate::agent::NormalizedEvent;
use crate::orchestrator::result::RunResult;
use crate::orchestrator::spec::{Step, TaskSpec};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

/// Records raw events to `trace.jsonl` within a run directory.
///
/// v0.6 redesign: only writes raw events, no SubAgentEvent wrapping.
/// Each line is one JSON-serialized `NormalizedEvent`.
pub struct TraceRecorder {
    run_dir: PathBuf,
}

impl TraceRecorder {
    pub fn create(run_id: &str) -> Result<Self, String> {
        let run_dir = Self::run_dir_for(run_id);
        Self::create_at_dir(run_dir)
    }

    pub fn create_in_root(root: &std::path::Path, run_id: &str) -> Result<Self, String> {
        Self::create_at_dir(root.join(run_id))
    }

    fn create_at_dir(run_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&run_dir).map_err(|e| e.to_string())?;
        Ok(Self { run_dir })
    }

    pub fn write_spec(&self, spec: &TaskSpec) -> Result<(), String> {
        let path = self.run_dir.join("spec.json");
        let json = serde_json::to_string_pretty(spec).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())
    }

    pub fn write_plan(&self, steps: &[Step]) -> Result<(), String> {
        let path = self.run_dir.join("plan.json");
        let json = serde_json::to_string_pretty(steps).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())
    }

    /// Append a single raw event to trace.jsonl.
    /// One event per line — no wrapping, no SubAgentEvent.
    pub fn append_event(&self, event: &NormalizedEvent) -> Result<(), String> {
        let path = self.run_dir.join("trace.jsonl");
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        let mut line = serde_json::to_string(event).map_err(|e| e.to_string())?;
        line.push('\n');
        file.write_all(line.as_bytes()).map_err(|e| e.to_string())
    }

    /// Append multiple events in a single I/O operation.
    pub fn append_events(&self, events: &[NormalizedEvent]) -> Result<(), String> {
        let path = self.run_dir.join("trace.jsonl");
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        for event in events {
            let mut line = serde_json::to_string(event).map_err(|e| e.to_string())?;
            line.push('\n');
            file.write_all(line.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn write_result(&self, result: &RunResult) -> Result<(), String> {
        let path = self.run_dir.join("result.json");
        let json = serde_json::to_string_pretty(result).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())
    }

    /// Write rework items to `rework.json` for parent run recovery.
    pub fn write_rework(
        &self,
        items: &[crate::orchestrator::rework::ReworkItem],
    ) -> Result<(), String> {
        let path = self.run_dir.join("rework.json");
        let json = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())
    }

    pub fn run_dir(&self) -> &PathBuf {
        &self.run_dir
    }

    fn run_dir_for(run_id: &str) -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".jishu-hub")
            .join("runs")
            .join(run_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn can_create_trace_recorder_under_explicit_root() {
        let root = std::env::temp_dir().join(format!("jishu_trace_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let trace = TraceRecorder::create_in_root(&root, "r_test").unwrap();

        assert_eq!(trace.run_dir(), &root.join("r_test"));
        assert!(root.join("r_test").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn append_event_writes_one_line_per_event() {
        let root =
            std::env::temp_dir().join(format!("jishu_trace_lines_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let trace = TraceRecorder::create_in_root(&root, "r_lines").unwrap();
        let event = NormalizedEvent::TextDelta {
            delta: "hello".into(),
        };
        trace.append_event(&event).unwrap();
        trace.append_event(&event).unwrap();

        let content =
            std::fs::read_to_string(root.join("r_lines/trace.jsonl")).unwrap();
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 2);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn append_events_batch_writes_all() {
        let root =
            std::env::temp_dir().join(format!("jishu_trace_batch_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let trace = TraceRecorder::create_in_root(&root, "r_batch").unwrap();
        let events = vec![
            NormalizedEvent::TextDelta {
                delta: "first".into(),
            },
            NormalizedEvent::TextDelta {
                delta: "second".into(),
            },
            NormalizedEvent::TextDelta {
                delta: "third".into(),
            },
        ];
        trace.append_events(&events).unwrap();

        let content =
            std::fs::read_to_string(root.join("r_batch/trace.jsonl")).unwrap();
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 3);

        let _ = std::fs::remove_dir_all(&root);
    }
}
