mod common;

use std::fs;

use common::write_pdf;
use pdq_core::{page_count, Error, PageCountRequest};

#[test]
fn page_count_counts_pages() {
    let directory = tempfile::tempdir().unwrap();
    let input = write_pdf(directory.path(), "in.pdf", &["P1", "P2", "P3"]);

    let count = page_count(&PageCountRequest {
        input,
        password: None,
    })
    .unwrap();

    assert_eq!(count, 3);
}

#[test]
fn page_count_rejects_empty_input_path() {
    let error = page_count(&PageCountRequest {
        input: "".into(),
        password: None,
    })
    .unwrap_err();

    assert!(matches!(error, Error::InvalidRequest(_)), "{error}");
}

#[test]
fn page_count_reports_non_pdf_input_with_its_path() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("not.pdf");
    fs::write(&input, b"this is not a pdf").unwrap();

    let error = page_count(&PageCountRequest {
        input,
        password: None,
    })
    .unwrap_err();

    assert!(matches!(error, Error::Operation { .. }), "{error}");
    assert!(error.to_string().contains("not.pdf"), "{error}");
}
