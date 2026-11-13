use std::io::{Cursor, Read};

use zyrite_export::{write_docx, Doc};

/// 1x1 透明 PNG
const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

fn document_xml(bytes: &[u8]) -> String {
    // .docx 是 zip；找 word/document.xml 的本地文件头，读出内容（docx-rs 用 deflate，借 zip 的格式太麻烦，这里只检查结构）
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("是 zip");
    let mut s = String::new();
    zip.by_name("word/document.xml")
        .unwrap()
        .read_to_string(&mut s)
        .unwrap();
    s
}

#[test]
fn 标题_列表_表格_代码_图片() {
    let json = format!(
        r#"{{
      "page": {{ "paper": "Letter", "marginMm": 25, "header": "我的笔记", "footer": "2026-11-08" }},
      "blocks": [
        {{ "t": "heading", "level": 1, "inlines": [{{ "t": "text", "text": "标题一" }}] }},
        {{ "t": "para", "inlines": [
          {{ "t": "text", "text": "粗体", "marks": {{ "bold": true }} }},
          {{ "t": "text", "text": "链接", "link": "https://z-y.ai" }},
          {{ "t": "text", "text": "code", "marks": {{ "code": true }} }},
          {{ "t": "image", "image": {{ "png": "{PNG}", "width": 20, "height": 10 }} }}
        ] }},
        {{ "t": "list", "ordered": true, "start": 3, "items": [
          {{ "blocks": [{{ "t": "para", "inlines": [{{ "t": "text", "text": "第三项" }}] }},
                        {{ "t": "list", "ordered": false, "items": [{{ "checked": true, "blocks": [{{ "t": "para", "inlines": [{{ "t": "text", "text": "子项" }}] }}] }}] }}] }}
        ] }},
        {{ "t": "quote", "blocks": [{{ "t": "para", "inlines": [{{ "t": "text", "text": "引用" }}] }}] }},
        {{ "t": "code", "lang": "rust", "text": "fn main() {{\n    println!();\n}}\n" }},
        {{ "t": "table", "align": [null, "right"], "rows": [
          [[{{ "t": "text", "text": "名" }}], [{{ "t": "text", "text": "数" }}]],
          [[{{ "t": "text", "text": "a" }}], [{{ "t": "text", "text": "1" }}]]
        ] }},
        {{ "t": "rule" }},
        {{ "t": "figure", "image": {{ "png": "{PNG}", "width": 4000, "height": 1000 }} }}
      ]
    }}"#
    );
    let doc: Doc = serde_json::from_str(&json).unwrap();
    let mut out = Cursor::new(Vec::new());
    write_docx(&doc, &mut out).unwrap();
    let xml = document_xml(out.get_ref());
    assert!(xml.contains(r#"<w:pStyle w:val="Heading1" />"#), "标题样式");
    assert!(
        xml.contains("标题一")
            && xml.contains("第三项")
            && xml.contains("☒ ")
            && xml.contains("子项")
    );
    assert!(xml.contains("<w:hyperlink"), "链接");
    assert!(xml.contains("<w:tbl>"), "表格");
    assert!(
        xml.contains("\u{a0}\u{a0}\u{a0}\u{a0}println!();"),
        "代码缩进保留"
    );
    assert!(xml.contains("<w:numPr>"), "列表编号");
    // 宽图缩到正文宽度：Letter 215.9mm - 50mm ≈ 627px
    let emu = 627u64 * 9525;
    assert!(xml.contains(&format!("cx=\"{emu}\"")), "宽图缩到正文宽度");
}

#[test]
fn 不是_png_报错() {
    let doc: Doc = serde_json::from_str(r#"{ "blocks": [{ "t": "figure", "image": { "png": "aGVsbG8=", "width": 1, "height": 1 } }] }"#).unwrap();
    assert!(write_docx(&doc, Cursor::new(Vec::new())).is_err());
}
