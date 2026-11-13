//! Word（.docx）导出：前端把 Markdown 转成下面的简单文档结构（图片、公式、Mermaid 都先转成 PNG），
//! 这里用 docx-rs 生成 Word 文件，保留标题层级、列表、表格、图片、代码块样式。不捆绑 pandoc。

use std::io::{Seek, Write};

use base64::Engine;
use docx_rs::{
    AbstractNumbering, AlignmentType, BorderType, Docx, Footer, Header, Hyperlink, HyperlinkType,
    IndentLevel, Level, LevelJc, LevelText, LineSpacing, NumberFormat, Numbering, NumberingId,
    PageMargin, PageNum, Paragraph, ParagraphBorder, ParagraphBorderPosition, Pic, Run, RunFonts,
    Shading, SpecialIndentType, Start, Style, StyleType, Table, TableCell, TableCellMargins,
    TableRow, WidthType,
};
use serde::Deserialize;

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("{}", msg::image(.0))]
    Image(String),
    #[error("{}", msg::pack(.0))]
    Pack(String),
}

/// 错误文案，按当前界面语言（见 zyrite-i18n）
mod msg {
    use zyrite_i18n::trf;

    pub fn image(e: &str) -> String {
        trf!("Invalid image data: {e}", "图片数据无效：{e}")
    }

    pub fn pack(e: &str) -> String {
        trf!(
            "Couldn't create the Word file: {e}",
            "生成 Word 文件失败：{e}"
        )
    }
}

/// 整个文档
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    pub blocks: Vec<Block>,
    #[serde(default)]
    pub page: Page,
}

/// 纸张和页眉页脚
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    /// "A4" 或 "Letter"
    pub paper: String,
    pub margin_mm: u32,
    pub header: Option<String>,
    pub footer: Option<String>,
}

impl Default for Page {
    fn default() -> Self {
        Page {
            paper: "A4".into(),
            margin_mm: 20,
            header: None,
            footer: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Block {
    Heading {
        level: u8,
        inlines: Vec<Inline>,
    },
    Para {
        inlines: Vec<Inline>,
    },
    Code {
        #[serde(default)]
        lang: Option<String>,
        text: String,
    },
    Quote {
        blocks: Vec<Block>,
    },
    List {
        ordered: bool,
        #[serde(default = "one")]
        start: u32,
        items: Vec<Item>,
    },
    Table {
        /// 每列的对齐："left" / "center" / "right" / null
        align: Vec<Option<String>>,
        /// 第一行是表头
        rows: Vec<Vec<Vec<Inline>>>,
    },
    Rule,
    /// 独占一段、居中的图（块级图片、公式、Mermaid）
    Figure {
        image: Image,
    },
}

fn one() -> u32 {
    1
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// 任务列表：Some(true/false)
    #[serde(default)]
    pub checked: Option<bool>,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Marks {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub code: bool,
    pub mark: bool,
    pub sup: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Inline {
    Text {
        text: String,
        #[serde(default)]
        marks: Marks,
        #[serde(default)]
        link: Option<String>,
    },
    Image {
        image: Image,
    },
    Break,
}

/// PNG（base64）和显示尺寸（CSS 像素）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub png: String,
    pub width: u32,
    pub height: u32,
}

const CODE_FONT: &str = "Consolas";
const BULLETS: [&str; 3] = ["•", "◦", "▪"];
/// 列表每层缩进（twip，1 英寸 = 1440）
const LIST_INDENT: i32 = 420;
const BULLET_NUMBERING: usize = 1;

struct Builder {
    docx: Docx,
    /// 正文宽度（像素，96 dpi），图片超过就等比缩小
    max_width_px: u32,
    next_numbering: usize,
}

/// 生成 .docx，写进 out
pub fn write_docx<W: Write + Seek>(doc: &Doc, out: W) -> Result<(), ExportError> {
    let (w_mm, h_mm) = if doc.page.paper.eq_ignore_ascii_case("letter") {
        (215.9, 279.4)
    } else {
        (210.0, 297.0)
    };
    let twip = |mm: f64| (mm / 25.4 * 1440.0).round() as i32;
    let margin = twip(doc.page.margin_mm as f64);
    let content_mm = w_mm - 2.0 * doc.page.margin_mm as f64;

    let mut docx = Docx::new()
        .page_size(twip(w_mm) as u32, twip(h_mm) as u32)
        .page_margin(PageMargin {
            top: margin,
            left: margin,
            bottom: margin,
            right: margin,
            header: margin / 2,
            footer: margin / 2,
            gutter: 0,
        })
        .default_size(21)
        .default_fonts(
            RunFonts::new()
                .ascii("Calibri")
                .hi_ansi("Calibri")
                .east_asia("Microsoft YaHei"),
        );
    for style in styles() {
        docx = docx.add_style(style);
    }
    // 无序列表共用一套编号定义
    let mut bullets = AbstractNumbering::new(BULLET_NUMBERING);
    for lvl in 0..9 {
        bullets = bullets.add_level(level(lvl, NumberFormat::new("bullet"), BULLETS[lvl % 3], 1));
    }
    docx = docx
        .add_abstract_numbering(bullets)
        .add_numbering(Numbering::new(BULLET_NUMBERING, BULLET_NUMBERING));

    if let Some(h) = doc.page.header.as_deref().filter(|s| !s.is_empty()) {
        docx = docx.header(
            Header::new().add_paragraph(
                Paragraph::new()
                    .align(AlignmentType::Right)
                    .add_run(Run::new().add_text(h).size(18).color("888888")),
            ),
        );
    }
    let mut footer = Paragraph::new().align(AlignmentType::Center);
    if let Some(f) = doc.page.footer.as_deref().filter(|s| !s.is_empty()) {
        footer = footer.add_run(
            Run::new()
                .add_text(format!("{f}  ·  "))
                .size(18)
                .color("888888"),
        );
    }
    docx = docx.footer(Footer::new().add_paragraph(footer.add_page_num(PageNum::new())));

    let mut b = Builder {
        docx,
        max_width_px: (content_mm / 25.4 * 96.0) as u32,
        next_numbering: BULLET_NUMBERING + 1,
    };
    for block in &doc.blocks {
        b.block(block, &Ctx::default())?;
    }
    b.docx
        .build()
        .pack(out)
        .map_err(|e| ExportError::Pack(e.to_string()))
}

fn level(lvl: usize, format: NumberFormat, text: &str, start: u32) -> Level {
    let left = LIST_INDENT * (lvl as i32 + 1);
    Level::new(
        lvl,
        Start::new(start as usize),
        format,
        LevelText::new(text),
        LevelJc::new("left"),
    )
    .indent(
        Some(left),
        Some(SpecialIndentType::Hanging(LIST_INDENT)),
        None,
        None,
    )
}

fn styles() -> Vec<Style> {
    let sizes = [36, 30, 26, 24, 22, 21];
    let mut out: Vec<Style> = sizes
        .iter()
        .enumerate()
        .map(|(i, &size)| {
            Style::new(format!("Heading{}", i + 1), StyleType::Paragraph)
                .name(format!("Heading {}", i + 1))
                .based_on("Normal")
                .next("Normal")
                .size(size)
                .bold()
                .outline_lvl(i)
                .line_spacing(
                    LineSpacing::new()
                        .before(if i < 2 { 360 } else { 240 })
                        .after(120),
                )
        })
        .collect();
    out.push(
        Style::new("CodeBlock", StyleType::Paragraph)
            .name("Code Block")
            .based_on("Normal")
            .fonts(
                RunFonts::new()
                    .ascii(CODE_FONT)
                    .hi_ansi(CODE_FONT)
                    .east_asia(CODE_FONT),
            )
            .size(18)
            .line_spacing(LineSpacing::new().before(0).after(0)),
    );
    out.push(
        Style::new("Quote", StyleType::Paragraph)
            .name("Quote")
            .based_on("Normal")
            .color("666666"),
    );
    out
}

#[derive(Default, Clone)]
struct Ctx {
    /// 引用的层数（左缩进 + 左边线）
    quote: usize,
    /// 列表里的层级和续段缩进
    list_level: Option<usize>,
}

impl Ctx {
    fn left_indent(&self) -> i32 {
        let list = self.list_level.map_or(0, |l| LIST_INDENT * (l as i32 + 1));
        list + 360 * self.quote as i32
    }

    /// 普通段落加上引用的缩进和左边线
    fn decorate(&self, mut p: Paragraph) -> Paragraph {
        if self.quote > 0 || self.list_level.is_some() {
            p = p.indent(Some(self.left_indent()), None, None, None);
        }
        if self.quote > 0 {
            p = p.style("Quote");
            p.property = p.property.set_border(
                ParagraphBorder::new(ParagraphBorderPosition::Left)
                    .val(BorderType::Single)
                    .size(12)
                    .space(8)
                    .color("CCCCCC"),
            );
        }
        p
    }
}

impl Builder {
    fn add(&mut self, mut p: Paragraph) {
        // 显式标上 Normal：styles.xml 里的 Normal 没有标成默认样式，有的读取器（python-docx 等）会拿不到段落样式
        if p.property.style.is_none() {
            p = p.style("Normal");
        }
        let docx = std::mem::take(&mut self.docx);
        self.docx = docx.add_paragraph(p);
    }

    fn block(&mut self, block: &Block, ctx: &Ctx) -> Result<(), ExportError> {
        match block {
            Block::Heading { level, inlines } => {
                let p = Paragraph::new().style(&format!("Heading{}", (*level).clamp(1, 6)));
                let p = self.inlines(p, inlines)?;
                self.add(ctx.decorate(p));
            }
            Block::Para { inlines } => {
                let p = self.inlines(Paragraph::new(), inlines)?;
                self.add(ctx.decorate(p));
            }
            Block::Code { text, .. } => self.code(text, ctx),
            Block::Quote { blocks } => {
                let inner = Ctx {
                    quote: ctx.quote + 1,
                    ..ctx.clone()
                };
                for b in blocks {
                    self.block(b, &inner)?;
                }
            }
            Block::List {
                ordered,
                start,
                items,
            } => self.list(*ordered, *start, items, ctx)?,
            Block::Table { align, rows } => self.table(align, rows)?,
            Block::Rule => {
                let mut p = Paragraph::new();
                p.property = p.property.set_border(
                    ParagraphBorder::new(ParagraphBorderPosition::Bottom)
                        .val(BorderType::Single)
                        .size(6)
                        .space(1)
                        .color("CCCCCC"),
                );
                self.add(p);
            }
            Block::Figure { image } => {
                let run = Run::new().add_image(self.pic(image)?);
                let p = Paragraph::new().align(AlignmentType::Center).add_run(run);
                self.add(ctx.decorate(p));
            }
        }
        Ok(())
    }

    fn list(
        &mut self,
        ordered: bool,
        start: u32,
        items: &[Item],
        ctx: &Ctx,
    ) -> Result<(), ExportError> {
        let lvl = ctx.list_level.map_or(0, |l| (l + 1).min(8));
        let numbering = if ordered {
            // 每个有序列表单独编号，从自己的起始数开始
            let id = self.next_numbering;
            self.next_numbering += 1;
            let mut abs = AbstractNumbering::new(id);
            for l in 0..9 {
                let fmt = ["decimal", "lowerLetter", "lowerRoman"][l % 3];
                abs = abs.add_level(level(
                    l,
                    NumberFormat::new(fmt),
                    &format!("%{}.", l + 1),
                    if l == lvl { start } else { 1 },
                ));
            }
            let docx = std::mem::take(&mut self.docx);
            self.docx = docx
                .add_abstract_numbering(abs)
                .add_numbering(Numbering::new(id, id));
            id
        } else {
            BULLET_NUMBERING
        };
        let inner = Ctx {
            list_level: Some(lvl),
            ..ctx.clone()
        };
        for item in items {
            let mut first = true;
            for b in &item.blocks {
                match b {
                    Block::Para { inlines } if first => {
                        first = false;
                        let mut p = Paragraph::new()
                            .numbering(NumberingId::new(numbering), IndentLevel::new(lvl));
                        if let Some(checked) = item.checked {
                            p = p.add_run(Run::new().add_text(if checked {
                                "☒ "
                            } else {
                                "☐ "
                            }));
                        }
                        let p = self.inlines(p, inlines)?;
                        // 编号段落的缩进由编号定义决定，只加引用的缩进
                        let p = if ctx.quote > 0 {
                            Ctx {
                                list_level: None,
                                ..ctx.clone()
                            }
                            .decorate(p)
                        } else {
                            p
                        };
                        self.add(p);
                    }
                    other => {
                        first = false;
                        self.block(other, &inner)?;
                    }
                }
            }
        }
        Ok(())
    }

    fn code(&mut self, text: &str, ctx: &Ctx) {
        // 代码块放进一个带底色、无边框的单元格里，整块有背景
        let mut cell = TableCell::new()
            .shading(Shading::new().fill("F5F5F4"))
            .width(9000, WidthType::Auto);
        for line in text.trim_end_matches('\n').split('\n') {
            // 行首空格用不换行空格，Word 不吞缩进
            let line = line.replace('\t', "    ");
            let lead = line.len() - line.trim_start_matches(' ').len();
            let shown = format!("{}{}", "\u{a0}".repeat(lead), &line[lead..]);
            cell = cell.add_paragraph(
                Paragraph::new()
                    .style("CodeBlock")
                    .add_run(Run::new().add_text(shown)),
            );
        }
        let mut table = Table::new(vec![TableRow::new(vec![cell])])
            .clear_all_border()
            .margins(TableCellMargins::new().margin(100, 160, 100, 160))
            .width(5000, WidthType::Pct);
        let indent = ctx.left_indent();
        if indent > 0 {
            table = table.indent(indent);
        }
        let docx = std::mem::take(&mut self.docx);
        self.docx = docx
            .add_table(table)
            .add_paragraph(Paragraph::new().size(8));
    }

    fn table(
        &mut self,
        align: &[Option<String>],
        rows: &[Vec<Vec<Inline>>],
    ) -> Result<(), ExportError> {
        let mut out = Vec::new();
        for (r, row) in rows.iter().enumerate() {
            let mut cells = Vec::new();
            for (c, inlines) in row.iter().enumerate() {
                let mut p = Paragraph::new();
                p = match align.get(c).and_then(|a| a.as_deref()) {
                    Some("center") => p.align(AlignmentType::Center),
                    Some("right") => p.align(AlignmentType::Right),
                    _ => p,
                };
                let mut p = self.inlines(p, inlines)?;
                if r == 0 {
                    p = p.bold();
                }
                let mut cell = TableCell::new().add_paragraph(p);
                if r == 0 {
                    cell = cell.shading(Shading::new().fill("F2F2F0"));
                }
                cells.push(cell);
            }
            out.push(TableRow::new(cells));
        }
        let table = Table::new(out).margins(TableCellMargins::new().margin(60, 100, 60, 100));
        let docx = std::mem::take(&mut self.docx);
        self.docx = docx
            .add_table(table)
            .add_paragraph(Paragraph::new().size(8));
        Ok(())
    }

    fn inlines(&mut self, mut p: Paragraph, inlines: &[Inline]) -> Result<Paragraph, ExportError> {
        for inline in inlines {
            match inline {
                Inline::Text { text, marks, link } => {
                    let mut run = Run::new().add_text(text);
                    if marks.bold {
                        run = run.bold();
                    }
                    if marks.italic {
                        run = run.italic();
                    }
                    if marks.strike {
                        run = run.strike();
                    }
                    if marks.code {
                        run = run
                            .fonts(RunFonts::new().ascii(CODE_FONT).hi_ansi(CODE_FONT))
                            .shading(Shading::new().fill("F2F2F0"));
                    }
                    if marks.mark {
                        run = run.highlight("yellow");
                    }
                    if marks.sup {
                        run.run_property = run
                            .run_property
                            .vert_align(docx_rs::VertAlignType::SuperScript);
                    }
                    p = match link {
                        Some(url) if !url.is_empty() => p.add_hyperlink(
                            Hyperlink::new(url, HyperlinkType::External)
                                .add_run(run.color("2F5BB7").underline("single")),
                        ),
                        _ => p.add_run(run),
                    };
                }
                Inline::Image { image } => p = p.add_run(Run::new().add_image(self.pic(image)?)),
                Inline::Break => {
                    p = p.add_run(Run::new().add_break(docx_rs::BreakType::TextWrapping))
                }
            }
        }
        Ok(p)
    }

    fn pic(&self, image: &Image) -> Result<Pic, ExportError> {
        let png = base64::engine::general_purpose::STANDARD
            .decode(image.png.trim())
            .map_err(|e| ExportError::Image(e.to_string()))?;
        if !png.starts_with(&[0x89, b'P', b'N', b'G']) {
            return Err(ExportError::Image(
                zyrite_i18n::tr("not a PNG", "不是 PNG").into(),
            ));
        }
        let (mut w, mut h) = (image.width.max(1), image.height.max(1));
        if w > self.max_width_px {
            h = (h as u64 * self.max_width_px as u64 / w as u64).max(1) as u32;
            w = self.max_width_px;
        }
        Ok(Pic::new_with_dimensions(png, w, h))
    }
}
