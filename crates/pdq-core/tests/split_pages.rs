mod common;

use std::{fs, path::Path};

use common::{markers_in, write_pdf};
use pdq_core::{page_count, split_pages, Error, PageCountRequest, SplitPagesRequest};

fn file_names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn pattern_in(directory: &Path, file_name: &str) -> String {
    directory.join(file_name).to_string_lossy().into_owned()
}

#[test]
fn split_pages_writes_one_file_per_page() {
    let directory = tempfile::tempdir().unwrap();
    let input = write_pdf(directory.path(), "in.pdf", &["P1", "P2", "P3"]);
    let output_directory = directory.path().join("out");
    fs::create_dir(&output_directory).unwrap();

    split_pages(&SplitPagesRequest {
        input,
        output_pattern: pattern_in(&output_directory, "page-%d.pdf"),
        pages_per_file: None,
        password: None,
    })
    .unwrap();

    assert_eq!(
        file_names(&output_directory),
        ["page-1.pdf", "page-2.pdf", "page-3.pdf"]
    );
    for (index, marker) in ["P1", "P2", "P3"].iter().enumerate() {
        let output = output_directory.join(format!("page-{}.pdf", index + 1));
        assert_eq!(markers_in(&output, &["P1", "P2", "P3"]), [*marker]);
    }
}

#[test]
fn split_pages_zero_pads_page_numbers_to_the_last_page_width() {
    let directory = tempfile::tempdir().unwrap();
    let markers: Vec<String> = (1..=10).map(|page| format!("P{page}")).collect();
    let marker_refs: Vec<&str> = markers.iter().map(String::as_str).collect();
    let input = write_pdf(directory.path(), "in.pdf", &marker_refs);
    let output_directory = directory.path().join("out");
    fs::create_dir(&output_directory).unwrap();

    split_pages(&SplitPagesRequest {
        input,
        output_pattern: pattern_in(&output_directory, "p%d.pdf"),
        pages_per_file: None,
        password: None,
    })
    .unwrap();

    let names = file_names(&output_directory);
    assert_eq!(names.len(), 10);
    assert_eq!(names.first().unwrap(), "p01.pdf");
    assert_eq!(names.last().unwrap(), "p10.pdf");
}

#[test]
fn split_pages_groups_pages_into_chunks() {
    let directory = tempfile::tempdir().unwrap();
    let input = write_pdf(directory.path(), "in.pdf", &["P1", "P2", "P3", "P4", "P5"]);
    let output_directory = directory.path().join("out");
    fs::create_dir(&output_directory).unwrap();

    split_pages(&SplitPagesRequest {
        input,
        output_pattern: pattern_in(&output_directory, "chunk-%d.pdf"),
        pages_per_file: Some(2),
        password: None,
    })
    .unwrap();

    assert_eq!(
        file_names(&output_directory),
        ["chunk-1.pdf", "chunk-2.pdf", "chunk-3.pdf"]
    );
    let pages_in = |name: &str| {
        page_count(&PageCountRequest {
            input: output_directory.join(name),
            password: None,
        })
        .unwrap()
    };
    assert_eq!(pages_in("chunk-1.pdf"), 2);
    assert_eq!(pages_in("chunk-2.pdf"), 2);
    assert_eq!(pages_in("chunk-3.pdf"), 1);
}

#[test]
fn split_pages_rejects_pattern_without_exactly_one_placeholder() {
    let directory = tempfile::tempdir().unwrap();
    let input = write_pdf(directory.path(), "in.pdf", &["P1"]);

    for pattern in ["page.pdf", "%d-%d.pdf"] {
        let error = split_pages(&SplitPagesRequest {
            input: input.clone(),
            output_pattern: pattern.to_string(),
            pages_per_file: None,
            password: None,
        })
        .unwrap_err();
        assert!(matches!(error, Error::InvalidRequest(_)), "{error}");
        assert!(error.to_string().contains("exactly one"), "{error}");
    }
}

#[test]
fn split_pages_rejects_zero_pages_per_file() {
    let directory = tempfile::tempdir().unwrap();
    let input = write_pdf(directory.path(), "in.pdf", &["P1"]);

    let error = split_pages(&SplitPagesRequest {
        input,
        output_pattern: pattern_in(directory.path(), "p%d.pdf"),
        pages_per_file: Some(0),
        password: None,
    })
    .unwrap_err();

    assert!(matches!(error, Error::InvalidRequest(_)), "{error}");
    assert!(error.to_string().contains("pagesPerFile"), "{error}");
}

#[test]
fn split_pages_rejects_empty_input_path() {
    let error = split_pages(&SplitPagesRequest {
        input: "".into(),
        output_pattern: "p%d.pdf".to_string(),
        pages_per_file: None,
        password: None,
    })
    .unwrap_err();

    assert!(matches!(error, Error::InvalidRequest(_)), "{error}");
}

#[test]
fn split_pages_reports_missing_input_with_its_path() {
    let directory = tempfile::tempdir().unwrap();

    let error = split_pages(&SplitPagesRequest {
        input: directory.path().join("missing.pdf"),
        output_pattern: pattern_in(directory.path(), "p%d.pdf"),
        pages_per_file: None,
        password: None,
    })
    .unwrap_err();

    assert!(matches!(error, Error::Operation { .. }), "{error}");
    assert!(error.to_string().contains("missing.pdf"), "{error}");
}

#[test]
fn split_pages_reports_missing_output_directory() {
    let directory = tempfile::tempdir().unwrap();
    let input = write_pdf(directory.path(), "in.pdf", &["P1"]);

    let error = split_pages(&SplitPagesRequest {
        input,
        output_pattern: pattern_in(&directory.path().join("no-such-directory"), "p%d.pdf"),
        pages_per_file: None,
        password: None,
    })
    .unwrap_err();

    assert!(matches!(error, Error::Operation { .. }), "{error}");
}
