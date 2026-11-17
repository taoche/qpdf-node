use std::path::{Path, PathBuf};

use crate::{Error, Result};

/// One input of a merge: a whole PDF, or the pages selected by `pages`.
#[derive(Debug, Clone)]
pub struct MergeInput {
    pub path: PathBuf,
    /// A pdq page range such as `1-3,7,r1`. `None` takes every page.
    pub pages: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MergeRequest {
    pub inputs: Vec<MergeInput>,
    pub output: PathBuf,
    /// Used only for encrypted inputs that do not open with the empty password.
    pub password: Option<String>,
}

/// Concatenates the inputs, in order, into `request.output` (unencrypted).
pub fn merge(request: &MergeRequest) -> Result<()> {
    if request.inputs.is_empty() {
        return Err(Error::invalid_request(
            "merge requires at least one input. inputs=[]",
        ));
    }
    require_path("merge output", &request.output)?;
    let mut pdq_inputs = Vec::with_capacity(request.inputs.len());
    for (index, input) in request.inputs.iter().enumerate() {
        require_path(&format!("merge inputs[{index}]"), &input.path)?;
        reject_output_equal_to_input(index, &input.path, &request.output)?;
        let ranges = match &input.pages {
            None => Vec::new(),
            Some(pages) => {
                let group = pdq::PageRangeGroup::parse(pages.as_str()).map_err(|err| {
                    Error::invalid_request(format!(
                        "merge inputs[{index}].pages is not a valid page range: {err}. pages={pages:?}, path={}",
                        input.path.display()
                    ))
                })?;
                vec![group]
            }
        };
        pdq_inputs.push(pdq::MergeInput {
            path: input.path.clone(),
            ranges,
        });
    }

    let options = pdq::MergeOptions {
        preserve_whole_single_input: false,
        password: request.password.clone(),
    };
    pdq::merge_with_options(&pdq_inputs, &request.output, options).map_err(|source| {
        let mut paths: Vec<PathBuf> = request
            .inputs
            .iter()
            .map(|input| input.path.clone())
            .collect();
        paths.push(request.output.clone());
        Error::operation("merge", paths, source)
    })
}

fn require_path(label: &str, path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() {
        return Err(Error::invalid_request(format!("{label} must not be empty")));
    }
    Ok(())
}

/// Writing over an input that pdq has memory-mapped is never what the caller
/// wants, so it is rejected up front instead of left to pdq.
fn reject_output_equal_to_input(index: usize, input: &Path, output: &Path) -> Result<()> {
    let (Ok(input_real), Ok(output_real)) = (input.canonicalize(), output.canonicalize()) else {
        return Ok(());
    };
    if input_real == output_real {
        return Err(Error::invalid_request(format!(
            "merge output must not be the same file as an input. input_index={index}, path={}",
            output.display()
        )));
    }
    Ok(())
}
