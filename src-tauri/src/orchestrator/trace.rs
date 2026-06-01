use crate::agent::NormalizedEvent;
use crate::orchestrator::result::RunResult;
use crate::orchestrator::spec::{Step, TaskSpec};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

pub struct TraceRecorder {
    run_dir: PathBuf,
}

impl TraceRecorder {
    pub fn create(run_id: &str) -> Result<Self, String> {
        let run_dir = Self::run_dir_for(run_id);
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

    pub fn write_result(&self, result: &RunResult) -> Result<(), String> {
        let path = self.run_dir.join("result.json");
        let json = serde_json::to_string_pretty(result).map_err(|e| e.to_string())?;
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
