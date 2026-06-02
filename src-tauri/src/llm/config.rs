use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPreset {
    pub id: String,
    pub display_name: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    /// Stored API key (plaintext). If empty, falls back to api_key_env env var.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Environment variable name to read the API key from as fallback.
    #[serde(default)]
    pub api_key_env: Option<String>,
    pub max_tokens: u32,
    pub temperature: f32,
    pub supports_tools: bool,
    pub supports_thinking: bool,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ModelStore {
    pub presets: Vec<ModelPreset>,
    pub active: Option<String>,
}

impl ModelStore {
    fn models_path() -> Result<std::path::PathBuf, String> {
        let home = dirs::home_dir().ok_or("Cannot find home directory")?;
        Ok(home.join(".jishu-agent").join("models.json"))
    }

    pub fn load() -> Result<Self, String> {
        let path = Self::models_path()?;
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Cannot read models.json: {e}"))?;
        serde_json::from_str(&content).map_err(|e| format!("Invalid models.json: {e}"))
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::models_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create directory {:?}: {e}", parent))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Cannot serialize: {e}"))?;
        crate::util::atomic_write(&path, json.as_bytes())
            .map_err(|e| format!("Cannot write models.json: {e}"))
    }

    pub fn add(&mut self, preset: ModelPreset) -> Result<(), String> {
        if self.presets.iter().any(|p| p.id == preset.id) {
            return Err(format!("Model '{}' already exists", preset.id));
        }
        self.presets.push(preset);
        self.save()
    }

    /// Update an existing preset in place. ID is matched on the existing entry;
    /// the new preset's `id` field is ignored to prevent accidental re-keying.
    pub fn update(&mut self, id: &str, preset: ModelPreset) -> Result<(), String> {
        let idx = self
            .presets
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| format!("Model '{id}' not found"))?;
        let mut new_preset = preset;
        new_preset.id = id.to_string();
        self.presets[idx] = new_preset;
        self.save()
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        self.presets.retain(|p| p.id != id);
        if self.active.as_deref() == Some(id) {
            self.active = None;
        }
        self.save()
    }

    pub fn set_active(&mut self, id: &str) -> Result<(), String> {
        if !self.presets.iter().any(|p| p.id == id) {
            return Err(format!("Model '{id}' not found"));
        }
        self.active = Some(id.to_string());
        self.save()
    }

    /// Clear the active preset. The store keeps all presets; none is selected.
    pub fn clear_active(&mut self) -> Result<(), String> {
        self.active = None;
        self.save()
    }

    pub fn get_active(&self) -> Option<&ModelPreset> {
        self.active
            .as_ref()
            .and_then(|id| self.presets.iter().find(|p| p.id == *id))
    }
}
