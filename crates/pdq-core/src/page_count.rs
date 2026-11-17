use std::path::PathBuf;

use crate::{Error, Result};

#[derive(Debug, Clone)]
pub struct PageCountRequest {
    pub input: PathBuf,
    pub password: Option<String>,
}

/// Counts pages by walking the page tree, so a wrong `/Count` entry cannot
/// disagree with what [`crate::merge`] and [`crate::split_pages`] would use.
pub fn page_count(request: &PageCountRequest) -> Result<u32> {
    if request.input.as_os_str().is_empty() {
        return Err(Error::invalid_request("pageCount input must not be empty"));
    }
    let count = pdq::page_count_with_password(&request.input, request.password.as_deref())
        .map_err(|source| Error::operation("pageCount", vec![request.input.clone()], source))?;
    u32::try_from(count).map_err(|_| {
        Error::invalid_request(format!(
            "page count does not fit in 32 bits. count={count}, input={}",
            request.input.display()
        ))
    })
}
