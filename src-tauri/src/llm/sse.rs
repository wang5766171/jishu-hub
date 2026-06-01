/// Parse Server-Sent Events from a line-based stream.
/// Returns data content from "data: ..." lines.
pub fn parse_sse_line(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if let Some(data) = trimmed.strip_prefix("data: ") {
        if data == "[DONE]" {
            return None;
        }
        return Some(data);
    }
    if let Some(data) = trimmed.strip_prefix("data:") {
        let data = data.trim();
        if data == "[DONE]" || data.is_empty() {
            return None;
        }
        return Some(data);
    }
    None
}

/// Buffer for converting an arbitrary byte stream into complete SSE lines.
pub struct SseLineBuffer {
    buffer: String,
}

impl SseLineBuffer {
    pub fn new() -> Self {
        Self {
            buffer: String::with_capacity(4096),
        }
    }

    /// Feed a chunk of bytes and return all complete lines found.
    /// Handles partial lines, empty lines, and comment lines (starting with `:`).
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        let text = String::from_utf8_lossy(chunk);
        self.buffer.push_str(&text);

        let mut lines = Vec::new();
        while let Some(pos) = self.buffer.find('\n') {
            let line = self.buffer[..pos].trim_end_matches('\r').to_string();
            self.buffer = self.buffer[pos + 1..].to_string();
            // Skip empty lines and comment lines
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            lines.push(line);
        }
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_data_line() {
        assert_eq!(
            parse_sse_line("data: {\"hello\":true}"),
            Some("{\"hello\":true}")
        );
    }

    #[test]
    fn parse_done() {
        assert_eq!(parse_sse_line("data: [DONE]"), None);
    }

    #[test]
    fn parse_empty() {
        assert_eq!(parse_sse_line(""), None);
        assert_eq!(parse_sse_line("event: ping"), None);
    }

    #[test]
    fn sse_buffer_complete_line() {
        let mut buf = SseLineBuffer::new();
        let lines = buf.feed(b"data: hello\n");
        assert_eq!(lines, vec!["data: hello"]);
    }

    #[test]
    fn sse_buffer_partial_then_rest() {
        let mut buf = SseLineBuffer::new();
        let lines1 = buf.feed(b"data: hel");
        assert!(lines1.is_empty());
        let lines2 = buf.feed(b"lo\n");
        assert_eq!(lines2, vec!["data: hello"]);
    }

    #[test]
    fn sse_buffer_multiple_lines_in_one_chunk() {
        let mut buf = SseLineBuffer::new();
        let lines = buf.feed(b"data: one\ndata: two\n");
        assert_eq!(lines, vec!["data: one", "data: two"]);
    }

    #[test]
    fn sse_buffer_skips_empty_and_comment_lines() {
        let mut buf = SseLineBuffer::new();
        let lines = buf.feed(b": comment\n\ndata: real\n\n");
        assert_eq!(lines, vec!["data: real"]);
    }

    #[test]
    fn sse_buffer_handles_crlf() {
        let mut buf = SseLineBuffer::new();
        let lines = buf.feed(b"data: hello\r\n");
        assert_eq!(lines, vec!["data: hello"]);
    }
}
