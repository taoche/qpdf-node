use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The request was rejected before any file was touched.
    #[error("{0}")]
    InvalidRequest(String),

    /// pdq failed while reading the inputs or writing the outputs.
    #[error("{operation} failed: {source}. paths={paths:?}")]
    Operation {
        operation: &'static str,
        paths: Vec<PathBuf>,
        #[source]
        source: pdq::PdfOpsError,
    },
}

impl Error {
    pub(crate) fn invalid_request(message: impl Into<String>) -> Self {
        Error::InvalidRequest(message.into())
    }

    pub(crate) fn operation(
        operation: &'static str,
        paths: Vec<PathBuf>,
        source: pdq::PdfOpsError,
    ) -> Self {
        Error::Operation {
            operation,
            paths,
            source,
        }
    }
}
