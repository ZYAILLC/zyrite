//! 全文搜索的查询语法：
//! - 空格分隔的词都要出现（不区分英文大小写）；`"短语"` 按整体匹配
//! - `-词`、`-"短语"`：排除
//! - `path:文件夹`（或 `folder:`）：只搜这个文件夹；`#标签`（或 `tag:标签`）：只搜带这个标签的笔记
//!
//! 匹配是子串匹配，所以中文不用分词就能命中："审阅" 能搜到 "逐段审阅"。

use serde::Serialize;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Query {
    /// 都要出现（已转成 ASCII 小写）
    pub terms: Vec<String>,
    pub exclude: Vec<String>,
    /// 相对库根目录的文件夹前缀
    pub folders: Vec<String>,
    pub tags: Vec<String>,
}

impl Query {
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty() && self.folders.is_empty() && self.tags.is_empty()
    }
}

pub fn parse(input: &str) -> Query {
    let mut q = Query::default();
    let mut chars = input.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        let negate = c == '-';
        if negate {
            chars.next();
        }
        // 一个词：引号里的短语，或到下一个空白为止
        let mut word = String::new();
        if chars.peek() == Some(&'"') {
            chars.next();
            for ch in chars.by_ref() {
                if ch == '"' {
                    break;
                }
                word.push(ch);
            }
        } else {
            while let Some(&ch) = chars.peek() {
                if ch.is_whitespace() {
                    break;
                }
                word.push(ch);
                chars.next();
            }
        }
        if word.is_empty() {
            continue;
        }
        let lower = word.to_ascii_lowercase();
        if !negate {
            if lower.starts_with("path:") || lower.starts_with("folder:") {
                // 文件夹名保留原来的大小写
                let v = word[word.find(':').map_or(0, |i| i + 1)..].trim_matches('/');
                if !v.is_empty() {
                    q.folders.push(v.to_string());
                }
                continue;
            }
            if let Some(v) = word.strip_prefix("tag:").or_else(|| word.strip_prefix('#')) {
                if !v.is_empty() {
                    q.tags.push(v.trim_start_matches('#').to_string());
                }
                continue;
            }
        }
        if negate {
            q.exclude.push(lower)
        } else {
            q.terms.push(lower)
        }
    }
    q
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line: usize,
    /// 命中处前面的文字（截短）
    pub before: String,
    pub text: String,
    pub after: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub rel: String,
    pub title: Option<String>,
    /// 这篇里命中的总次数
    pub count: usize,
    /// 前几处命中（含上下文）
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// 命中的笔记总数（hits 只返回前 limit 篇）
    pub total_notes: usize,
    pub total_matches: usize,
    pub elapsed_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 查询语法() {
        let q =
            parse(r#"审阅 "Agent 写入" -草稿 -"旧 方案" path:docs/ #项目/zyrite tag:agent Plan"#);
        assert_eq!(q.terms, vec!["审阅", "agent 写入", "plan"]);
        assert_eq!(q.exclude, vec!["草稿", "旧 方案"]);
        assert_eq!(q.folders, vec!["docs"]);
        assert_eq!(q.tags, vec!["项目/zyrite", "agent"]);
        assert!(parse("  ").is_empty());
        assert_eq!(parse("Folder:Notes/日记").folders, vec!["Notes/日记"]);
        assert_eq!(parse("\"未闭合的短语").terms, vec!["未闭合的短语"]);
    }
}
