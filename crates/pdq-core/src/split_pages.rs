use std::path::PathBuf;

use crate::{Error, Result};

#[derive(Debug, Clone)]
pub struct SplitPagesRequest {
    pub input: PathBuf,
    /// Output path template containing exactly one `%d`.
    pub output_pattern: String,
    /// Consecutive pages per output file. `None` means one page per file.
    pub pages_per_file: Option<u32>,
    pub password: Option<String>,
}

/// Splits `request.input` into one or more files named by the pattern.
///
/// With one page per file, `%d` is the original page number zero-padded to the
/// width of the last page number. With larger chunks, `%d` is the 1-based chunk
/// index, zero-padded to the width of the chunk count. Existing files are
/// overwritten.
pub fn split_pages(request: &SplitPagesRequest) -> Result<()> {
    if request.input.as_os_str().is_empty() {
        return Err(Error::invalid_request("splitPages input must not be empty"));
    }
    let placeholder_count = request.output_pattern.matches("%d").count();
    if placeholder_count != 1 {
        return Err(Error::invalid_request(format!(
            "splitPages outputPattern must contain exactly one \"%d\". placeholder_count={placeholder_count}, outputPattern={:?}",
            request.output_pattern
        )));
    }
    let pages_per_file = request.pages_per_file.unwrap_or(1);
    if pages_per_file == 0 {
        return Err(Error::invalid_request(
            "splitPages pagesPerFile must be at least 1. pagesPerFile=0",
        ));
    }

    let options = pdq::SplitPagesOptions {
        pages_per_file: pages_per_file as usize,
        password: request.password.clone(),
    };
    pdq::split_pages_with_options(&request.input, &request.output_pattern, &options).map_err(
        |source| {
            Error::operation(
                "splitPages",
                vec![
                    request.input.clone(),
                    PathBuf::from(&request.output_pattern),
                ],
                source,
            )
        },
    )
}
