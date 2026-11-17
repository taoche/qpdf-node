//! Validated, path-based PDF operations on top of the [`pdq`] crate.
//!
//! This crate has no Node.js dependency. The Node binding in `packages/node`
//! maps JavaScript options onto the request types defined here, so every
//! binding shares one set of validation rules.
//!
//! All operations are synchronous and blocking. pdq reads and writes files by
//! path (memory-mapped input, atomic temp-file output for merges); there is no
//! bytes-in/bytes-out API.

#![forbid(unsafe_code)]

mod error;
mod merge;
mod page_count;
mod split_pages;

pub use error::{Error, Result};
pub use merge::{merge, MergeInput, MergeRequest};
pub use page_count::{page_count, PageCountRequest};
pub use split_pages::{split_pages, SplitPagesRequest};
