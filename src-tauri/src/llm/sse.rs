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
}
