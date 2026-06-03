/// Truncate a string to `max` characters, appending `~` if truncated.
pub fn truncate_str(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max - 1).collect();
        format!("{}~", truncated)
    }
}

/// Truncate a byte slice to `max` bytes, keeping `head` bytes from the start
/// and `tail` bytes from the end, inserting a placeholder in between.
///
/// Returns the (possibly truncated) string. Invalid UTF-8 boundaries are
/// avoided by falling back to lossy conversion.
pub fn truncate_head_tail(input: &str, max: usize, head: usize, tail: usize) -> String {
    let bytes = input.as_bytes();
    if bytes.len() <= max {
        return input.to_string();
    }
    let head_end = head.min(max / 2);
    let tail_start = bytes
        .len()
        .saturating_sub(tail)
        .max(max.saturating_sub(tail));
    if tail_start <= head_end {
        // Not enough room for both; just take the first `max` bytes.
        let s = String::from_utf8_lossy(&bytes[..max]).to_string();
        return format!("{}\n... (truncated)", s);
    }
    let head_str = String::from_utf8_lossy(&bytes[..head_end]);
    let tail_str = String::from_utf8_lossy(&bytes[tail_start..]);
    let omitted = bytes.len() - head_end - (bytes.len() - tail_start);
    format!(
        "{}\n... (truncated {} bytes)\n{}",
        head_str, omitted, tail_str
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_truncation_when_fits() {
        let s = "hello world";
        assert_eq!(truncate_head_tail(s, 100, 10, 10), s);
    }

    #[test]
    fn truncates_long_input() {
        let s = "a".repeat(200);
        let result = truncate_head_tail(&s, 50, 10, 10);
        assert!(result.contains("truncated"));
        assert!(result.starts_with(&"a".repeat(10)));
        assert!(result.ends_with(&"a".repeat(10)));
    }

    #[test]
    fn tiny_max_just_truncates() {
        let s = "abcdefghij";
        let result = truncate_head_tail(s, 5, 10, 10);
        assert!(result.contains("truncated"));
    }
}
