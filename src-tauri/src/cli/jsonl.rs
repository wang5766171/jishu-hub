use std::io::Write;

/// Writes one JSON-lines record per call to stdout.
pub struct JsonlWriter {
    out: std::io::BufWriter<std::io::Stdout>,
}

impl JsonlWriter {
    pub fn stdout() -> Self {
        Self {
            out: std::io::BufWriter::new(std::io::stdout()),
        }
    }

    /// Serialize `ev` as a single JSON line and flush.
    pub fn emit<T: serde::Serialize>(&mut self, ev: &T) -> std::io::Result<()> {
        let mut line = serde_json::to_string(ev)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        line.push('\n');
        self.out.write_all(line.as_bytes())?;
        self.out.flush()?;
        Ok(())
    }
}
