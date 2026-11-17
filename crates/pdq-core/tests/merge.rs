mod common;

use std::fs;

use common::{markers_in, write_pdf};
use pdq_core::{merge, page_count, Error, MergeInput, MergeRequest, PageCountRequest};

const ALL_MARKERS: [&str; 5] = ["A1", "A2", "A3", "B1", "B2"];

fn whole(path: std::path::PathBuf) -> MergeInput {
    MergeInput { path, pages: None }
}

fn count_pages(path: &std::path::Path) -> u32 {
    page_count(&PageCountRequest {
        input: path.to_path_buf(),
        password: None,
    })
    .expect("count pages")
}

#[test]
fn merge_concatenates_whole_inputs_in_order() {
    let directory = tempfile::tempdir().unwrap();
    let first = write_pdf(directory.path(), "a.pdf", &["A1", "A2", "A3"]);
    let second = write_pdf(directory.path(), "b.pdf", &["B1", "B2"]);
    let output = directory.path().join("merged.pdf");

    merge(&MergeRequest {
        inputs: vec![whole(first), whole(second)],
        output: output.clone(),
        password: None,
    })
    .unwrap();

    assert_eq!(count_pages(&output), 5);
    assert_eq!(markers_in(&output, &ALL_MARKERS), ALL_MARKERS);
}

#[test]
fn merge_selects_pages_per_input() {
    let directory = tempfile::tempdir().unwrap();
    let first = write_pdf(directory.path(), "a.pdf", &["A1", "A2", "A3"]);
    let second = write_pdf(directory.path(), "b.pdf", &["B1", "B2"]);
    let output = directory.path().join("merged.pdf");

    merge(&MergeRequest {
        inputs: vec![
            MergeInput {
                path: first,
                pages: Some("3,1".to_string()),
            },
            MergeInput {
                path: second,
                pages: Some("r1".to_string()),
            },
        ],
        output: output.clone(),
        password: None,
    })
    .unwrap();

    assert_eq!(count_pages(&output), 3);
    assert_eq!(markers_in(&output, &ALL_MARKERS), ["A3", "A1", "B2"]);
}

#[test]
fn merge_single_input_rewrites_the_document() {
    let directory = tempfile::tempdir().unwrap();
    let input = write_pdf(directory.path(), "a.pdf", &["A1", "A2"]);
    let output = directory.path().join("copy.pdf");

    merge(&MergeRequest {
        inputs: vec![whole(input)],
        output: output.clone(),
        password: None,
    })
    .unwrap();

    assert_eq!(count_pages(&output), 2);
    assert!(fs::read(&output).unwrap().starts_with(b"%PDF-"));
}

#[test]
fn merge_rejects_empty_inputs() {
    let directory = tempfile::tempdir().unwrap();
    let error = merge(&MergeRequest {
        inputs: Vec::new(),
        output: directory.path().join("out.pdf"),
        password: None,
    })
    .unwrap_err();

    assert!(matches!(error, Error::InvalidRequest(_)), "{error}");
    assert!(error.to_string().contains("at least one input"), "{error}");
}

#[test]
fn merge_rejects_empty_paths() {
    let directory = tempfile::tempdir().unwrap();
    let input = write_pdf(directory.path(), "a.pdf", &["A1"]);

    let empty_output = merge(&MergeRequest {
        inputs: vec![whole(input)],
        output: "".into(),
        password: None,
    })
    .unwrap_err();
    assert!(
        empty_output
            .to_string()
            .contains("merge output must not be empty"),
        "{empty_output}"
    );

    let empty_input = merge(&MergeRequest {
        inputs: vec![whole("".into())],
        output: directory.path().join("out.pdf"),
        password: None,
    })
    .unwrap_err();
    assert!(
        empty_input
            .to_string()
            .contains("merge inputs[0] must not be empty"),
        "{empty_input}"
    );
}

#[test]
fn merge_rejects_invalid_page_range_with_input_index() {
    let directory = tempfile::tempdir().unwrap();
    let first = write_pdf(directory.path(), "a.pdf", &["A1"]);
    let second = write_pdf(directory.path(), "b.pdf", &["B1"]);
    let output = directory.path().join("out.pdf");

    let error = merge(&MergeRequest {
        inputs: vec![
            whole(first),
            MergeInput {
                path: second,
                pages: Some("0".to_string()),
            },
        ],
        output: output.clone(),
        password: None,
    })
    .unwrap_err();

    assert!(matches!(error, Error::InvalidRequest(_)), "{error}");
    assert!(error.to_string().contains("inputs[1].pages"), "{error}");
    assert!(!output.exists());
}

#[test]
fn merge_reports_out_of_bounds_page_as_operation_error() {
    let directory = tempfile::tempdir().unwrap();
    let input = write_pdf(directory.path(), "a.pdf", &["A1", "A2"]);
    let output = directory.path().join("out.pdf");

    let error = merge(&MergeRequest {
        inputs: vec![MergeInput {
            path: input,
            pages: Some("5".to_string()),
        }],
        output: output.clone(),
        password: None,
    })
    .unwrap_err();

    assert!(matches!(error, Error::Operation { .. }), "{error}");
    assert!(error.to_string().contains("out of bounds"), "{error}");
    assert!(!output.exists());
}

#[test]
fn merge_rejects_output_that_is_an_input() {
    let directory = tempfile::tempdir().unwrap();
    let input = write_pdf(directory.path(), "a.pdf", &["A1"]);
    let original = fs::read(&input).unwrap();

    let error = merge(&MergeRequest {
        inputs: vec![whole(input.clone())],
        output: input.clone(),
        password: None,
    })
    .unwrap_err();

    assert!(matches!(error, Error::InvalidRequest(_)), "{error}");
    assert_eq!(fs::read(&input).unwrap(), original);
}

#[test]
fn merge_reports_missing_input_with_its_path() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("missing.pdf");

    let error = merge(&MergeRequest {
        inputs: vec![whole(missing)],
        output: directory.path().join("out.pdf"),
        password: None,
    })
    .unwrap_err();

    assert!(matches!(error, Error::Operation { .. }), "{error}");
    assert!(error.to_string().contains("missing.pdf"), "{error}");
}

#[test]
fn merge_reports_non_pdf_input() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("not.pdf");
    fs::write(&input, b"this is not a pdf").unwrap();

    let error = merge(&MergeRequest {
        inputs: vec![whole(input)],
        output: directory.path().join("out.pdf"),
        password: None,
    })
    .unwrap_err();

    assert!(matches!(error, Error::Operation { .. }), "{error}");
}

#[test]
fn merge_reports_missing_output_directory() {
    let directory = tempfile::tempdir().unwrap();
    let input = write_pdf(directory.path(), "a.pdf", &["A1"]);

    let error = merge(&MergeRequest {
        inputs: vec![whole(input)],
        output: directory.path().join("no-such-directory").join("out.pdf"),
        password: None,
    })
    .unwrap_err();

    assert!(matches!(error, Error::Operation { .. }), "{error}");
    assert!(error.to_string().contains("no-such-directory"), "{error}");
}
