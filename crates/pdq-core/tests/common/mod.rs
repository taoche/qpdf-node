//! Hand-built PDF fixtures, so tests need neither qpdf nor committed binaries.
#![allow(dead_code)] // each test binary uses a different subset of these helpers

use std::{
    fs,
    path::{Path, PathBuf},
};

/// Builds a valid PDF with one page per marker. Each page's content stream
/// draws its marker text uncompressed, so tests can find which pages an output
/// holds by searching its bytes.
pub fn pdf_with_markers(markers: &[&str]) -> Vec<u8> {
    let page_object_number = |index: usize| 4 + index * 2;
    let kids: Vec<String> = (0..markers.len())
        .map(|index| format!("{} 0 R", page_object_number(index)))
        .collect();

    let mut objects: Vec<String> = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.join(" "),
            markers.len()
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    for (index, marker) in markers.iter().enumerate() {
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents {} 0 R >>",
            page_object_number(index) + 1
        ));
        let content = format!("BT /F1 12 Tf 20 100 Td ({marker}) Tj ET");
        objects.push(format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len()
        ));
    }

    let mut bytes = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
    }
    let xref_offset = bytes.len();
    bytes.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    bytes.extend_from_slice(b"0000000000 65535 f \n");
    for offset in offsets {
        bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    bytes
}

pub fn write_pdf(directory: &Path, file_name: &str, markers: &[&str]) -> PathBuf {
    let path = directory.join(file_name);
    fs::write(&path, pdf_with_markers(markers)).expect("write fixture PDF");
    path
}

/// Returns the markers present in `path`, in the order they appear in the file.
pub fn markers_in(path: &Path, candidates: &[&str]) -> Vec<String> {
    let bytes = fs::read(path).expect("read output PDF");
    let text = String::from_utf8_lossy(&bytes);
    let mut found: Vec<(usize, String)> = candidates
        .iter()
        .filter_map(|marker| {
            text.find(&format!("({marker})"))
                .map(|position| (position, (*marker).to_string()))
        })
        .collect();
    found.sort();
    found.into_iter().map(|(_, marker)| marker).collect()
}
