//! 从一篇笔记里提取双链、Markdown 链接、标签、标题和 frontmatter 里的 tags / aliases。
//!
//! 轻量的逐行扫描，不做完整的 Markdown 解析：跳过围栏代码块、行内代码和 frontmatter 正文以外的部分，
//! 足够建立链接图；编辑器里的渲染用的是完整解析器。

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    /// `[[笔记]]`、`![[嵌入]]`
    Wiki,
    /// `[文字](相对路径.md)`
    Markdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub kind: LinkKind,
    /// 链接目标：双链是 `#` 和 `|` 之前的部分；Markdown 链接是解码后的路径（去掉锚点）
    pub target: String,
    pub embed: bool,
    /// 所在行（从 0 开始）
    pub line: usize,
    /// 在该行里的字节区间（含两侧的括号），改名时用来改写
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoteMeta {
    pub title: Option<String>,
    pub aliases: Vec<String>,
    /// 不含 `#`，去重，保持出现顺序
    pub tags: Vec<String>,
    pub links: Vec<Link>,
}

static TAG_RE: LazyLock<Regex> = LazyLock::new(|| {
    // 和 packages/editor-live/src/syntax.ts、md-blocks 的标签规则一致：前面是行首、空白或中文标点
    Regex::new(r"(?:^|[\s(（，。；：、])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)").unwrap()
});
static MD_LINK_RE: LazyLock<Regex> =
    // 地址可以用尖括号包住（这时可以含空格）：[文字](<my note.md>)
    LazyLock::new(|| {
        Regex::new(r"(!?)\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+[^)]*)?\)").unwrap()
    });
static HEADING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ {0,3}#\s+(.+?)\s*#*\s*$").unwrap());

/// 一行里行内代码的位置换成空格（字节长度不变，偏移仍然对应原文）。
/// 多字节字符的每个字节都换成空格，结果仍是合法的 UTF-8。
fn mask_code_spans(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let run = bytes[i..].iter().take_while(|&&b| b == b'`').count();
            let fence = &line[i..i + run];
            if let Some(close) = line[i + run..].find(fence) {
                let end = i + run + close + run;
                out[i..end].fill(b' ');
                i = end;
                continue;
            }
            i += run;
            continue;
        }
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| line.to_string())
}

/// 整篇的代码（围栏代码块、行内代码）换成空格，长度不变。找未链接提及时用，避免命中代码里的文字
pub fn mask_code(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut fence: Option<(char, usize)> = None;
    for line in text.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        let trimmed = body.trim_start();
        let c = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        let mut is_fence = false;
        if let Some(c) = c {
            let run = trimmed.chars().take_while(|x| *x == c).count();
            if run >= 3 && body.len() - trimmed.len() <= 3 {
                match fence {
                    None => {
                        fence = Some((c, run));
                        is_fence = true;
                    }
                    Some((fc, fr)) if fc == c && run >= fr && trimmed[run..].trim().is_empty() => {
                        fence = None;
                        is_fence = true;
                    }
                    _ => {}
                }
            }
        }
        if is_fence || fence.is_some() {
            out.extend(std::iter::repeat_n(' ', body.len()));
            out.push_str(&line[body.len()..]);
        } else {
            out.push_str(&mask_code_spans(body));
            out.push_str(&line[body.len()..]);
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let (Some(h), Some(l)) = (
                bytes.get(i + 1).and_then(|&b| hex(b)),
                bytes.get(i + 2).and_then(|&b| hex(b)),
            ) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn is_url(s: &str) -> bool {
    let Some(colon) = s.find(':') else {
        return false;
    };
    colon > 1
        && s[..colon]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
}

pub fn is_markdown_path(s: &str) -> bool {
    let lower = s.to_lowercase();
    [".md", ".markdown", ".mdown", ".mkd", ".mdx"]
        .iter()
        .any(|e| lower.ends_with(e))
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    let q = s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')));
    if q {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// frontmatter 里的列表值：`[a, b]`、`a, b`、或下面几行 `- a`
fn yaml_list(inline: &str, following: &[&str]) -> Vec<String> {
    let v = inline.trim();
    let items: Vec<String> = if v.is_empty() {
        following
            .iter()
            .map(|l| l.trim_start())
            .take_while(|l| l.starts_with("- ") || *l == "-")
            .map(|l| unquote(l.trim_start_matches('-')))
            .collect()
    } else {
        v.trim_start_matches('[')
            .trim_end_matches(']')
            .split(',')
            .map(unquote)
            .collect()
    };
    items.into_iter().filter(|s| !s.is_empty()).collect()
}

fn push_tag(meta: &mut NoteMeta, tag: &str) {
    let tag = tag.trim_start_matches('#').trim_end_matches('/');
    if !tag.is_empty() && !meta.tags.iter().any(|t| t == tag) {
        meta.tags.push(tag.to_string());
    }
}

pub fn extract(text: &str) -> NoteMeta {
    let mut meta = NoteMeta::default();
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;

    // frontmatter
    if lines.first().map(|l| l.trim_end()) == Some("---") {
        if let Some(end) = lines
            .iter()
            .skip(1)
            .position(|l| matches!(l.trim_end(), "---" | "..."))
        {
            let body = &lines[1..=end];
            for (k, line) in body.iter().enumerate() {
                let Some((key, value)) = line.split_once(':') else {
                    continue;
                };
                if key.starts_with(' ') {
                    continue;
                }
                match key.trim().to_lowercase().as_str() {
                    "tags" | "tag" => {
                        for t in yaml_list(value, &body[k + 1..]) {
                            for part in t.split_whitespace() {
                                push_tag(&mut meta, part);
                            }
                        }
                    }
                    "aliases" | "alias" => meta.aliases = yaml_list(value, &body[k + 1..]),
                    "title" => {
                        let t = unquote(value);
                        if !t.is_empty() {
                            meta.title = Some(t);
                        }
                    }
                    _ => {}
                }
            }
            i = end + 2;
        }
    }

    let mut fence: Option<(char, usize)> = None;
    for (n, raw) in lines.iter().enumerate().skip(i) {
        let trimmed = raw.trim_start();
        // 围栏代码块（``` 或 ~~~，关闭的围栏至少一样长）
        let fence_char = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        if let Some(c) = fence_char {
            let run = trimmed.chars().take_while(|x| *x == c).count();
            if run >= 3 && raw.len() - trimmed.len() <= 3 {
                match fence {
                    None => {
                        fence = Some((c, run));
                        continue;
                    }
                    Some((fc, fr)) if fc == c && run >= fr && trimmed[run..].trim().is_empty() => {
                        fence = None;
                        continue;
                    }
                    _ => {}
                }
            }
        }
        if fence.is_some() {
            continue;
        }

        if meta.title.is_none() {
            if let Some(m) = HEADING_RE.captures(raw) {
                meta.title = Some(m[1].to_string());
            }
        }

        let line = mask_code_spans(raw);

        // 双链 [[目标#标题|别名]]
        let mut from = 0;
        while let Some(open) = line[from..].find("[[") {
            let start = from + open;
            let Some(close) = line[start + 2..].find("]]") else {
                break;
            };
            let inner = &line[start + 2..start + 2 + close];
            let end = start + 2 + close + 2;
            if !inner.is_empty() && !inner.contains('[') {
                let embed = start > 0 && line.as_bytes()[start - 1] == b'!';
                let target = inner
                    .split(['|', '#'])
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                meta.links.push(Link {
                    kind: LinkKind::Wiki,
                    target,
                    embed,
                    line: n,
                    start: if embed { start - 1 } else { start },
                    end,
                });
            }
            from = end;
        }

        // Markdown 链接到本地的 .md 文件
        for m in MD_LINK_RE.captures_iter(&line) {
            let whole = m.get(0).unwrap();
            let url = m.get(2).or(m.get(3)).map_or("", |g| g.as_str());
            if is_url(url) || url.starts_with('#') {
                continue;
            }
            let path = percent_decode(url.split(['#', '?']).next().unwrap_or(""));
            if !is_markdown_path(&path) {
                continue;
            }
            meta.links.push(Link {
                kind: LinkKind::Markdown,
                target: path,
                embed: !m[1].is_empty(),
                line: n,
                start: whole.start(),
                end: whole.end(),
            });
        }

        // 标签（标题行 `# xxx` 的 # 后面有空格，不会被当成标签）
        for m in TAG_RE.captures_iter(&line) {
            push_tag(&mut meta, &m[1]);
        }
    }
    meta
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 双链_markdown_链接_标签() {
        let m = extract(
            "# 标题\n\n见 [[笔记]]、[[docs/方案#定位|方案]] 和 ![[图.png|300]]。\n\
             还有 [架构](../docs/architecture.md#分层) 与 [外链](https://x.md) 和 [图](a.png)。\n\
             标签 #项目/zyrite #agent，不是标签：a#b、#123。\n",
        );
        assert_eq!(m.title.as_deref(), Some("标题"));
        let targets: Vec<_> = m
            .links
            .iter()
            .map(|l| (l.kind, l.target.as_str(), l.embed))
            .collect();
        assert_eq!(
            targets,
            vec![
                (LinkKind::Wiki, "笔记", false),
                (LinkKind::Wiki, "docs/方案", false),
                (LinkKind::Wiki, "图.png", true),
                (LinkKind::Markdown, "../docs/architecture.md", false),
            ]
        );
        assert_eq!(m.tags, vec!["项目/zyrite", "agent"]);
        // 区间对应原文
        let line = "见 [[笔记]]、[[docs/方案#定位|方案]] 和 ![[图.png|300]]。";
        let l = &m.links[1];
        assert_eq!(&line[l.start..l.end], "[[docs/方案#定位|方案]]");
        assert_eq!(&line[m.links[2].start..m.links[2].end], "![[图.png|300]]");
    }

    #[test]
    fn 跳过代码() {
        let m =
            extract("```md\n[[不算]] #不算\n```\n行内 `[[不算]]` 和 [[算]]\n~~~~\n#也不算\n~~~~\n");
        assert_eq!(
            m.links
                .iter()
                .map(|l| l.target.as_str())
                .collect::<Vec<_>>(),
            vec!["算"]
        );
        assert!(m.tags.is_empty());
    }

    #[test]
    fn frontmatter() {
        let m = extract("---\ntitle: \"真正的标题\"\ntags:\n  - moc\n  - project/zyrite\naliases: [别名一, '别名二']\n---\n# 不是标题\n#inline\n");
        assert_eq!(m.title.as_deref(), Some("真正的标题"));
        assert_eq!(m.tags, vec!["moc", "project/zyrite", "inline"]);
        assert_eq!(m.aliases, vec!["别名一", "别名二"]);
        let m = extract("---\ntags: a b\n---\n");
        assert_eq!(m.tags, vec!["a", "b"]);
    }

    #[test]
    fn 遮住代码_长度不变() {
        let src = "前 `代码 [[x]]` 后\n```\n中文 [[y]]\n```\n正文\n";
        let m = mask_code(src);
        assert_eq!(m.len(), src.len());
        assert!(!m.contains("[[") && m.contains("正文") && m.contains("前"));
    }

    #[test]
    fn 百分号解码() {
        let m = extract("[x](my%20note.md) [y](<other note.md>)\n");
        assert_eq!(
            m.links
                .iter()
                .map(|l| l.target.as_str())
                .collect::<Vec<_>>(),
            vec!["my note.md", "other note.md"]
        );
        // % 后面跟中文、不完整的 % 不应崩溃
        assert_eq!(percent_decode("100%完成.md"), "100%完成.md");
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("%E6%96%B9%E6%A1%88.md"), "方案.md");
    }
}
