//! 库的链接图和标签索引：反向链接、未链接提及、标签、双链解析。
//!
//! 先放在内存里：打开库时后台建一次，之后随文件监听逐个文件更新。
//! SQLite 持久化（`.zyrite/cache.sqlite`）等 1 万篇冷启动验收时再加。
//!
//! 双链解析规则和 Obsidian 一致：
//! - `[[名字]]`：按文件名（不含扩展名，不区分大小写）在整个库里找；重名时优先同一文件夹，其次路径最短
//! - `[[文件夹/名字]]`：按路径找，先相对当前笔记，再相对库根目录
//! - 带非 Markdown 扩展名的（`![[图.png]]`）是附件，不算笔记链接

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::links::{extract, is_markdown_path, mask_code, Link, LinkKind, NoteMeta};
use crate::search::{self, SearchHit, SearchMatch, SearchResult};
use crate::vault;
use crate::watch::{Change, ChangeKind};

pub struct Note {
    pub rel: String,
    /// 文件名去掉扩展名
    pub stem: String,
    pub meta: NoteMeta,
    text: String,
    /// text 的 ASCII 小写（长度和 text 一样，偏移通用），搜索和找未链接提及用
    lower: String,
    /// 代码（围栏代码块、行内代码）的字节区间：未链接提及不算代码里的
    code: Vec<(usize, usize)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteName {
    pub rel: String,
    pub stem: String,
    pub title: Option<String>,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    /// 提及所在的笔记（相对路径）
    pub from: String,
    pub line: usize,
    /// 所在行的文字（过长时截取提及前后）
    pub context: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    /// 有这个标签的笔记数
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Resolved {
    /// 指向库里的笔记
    Note { rel: String },
    /// 笔记不存在（显示成虚线，点击创建）
    Missing,
    /// 附件或库外的文件，不参与链接图
    Other,
}

/// 未链接提及最多列多少篇
pub const MENTION_LIMIT: usize = 100;

#[derive(Default)]
pub struct Index {
    root: PathBuf,
    notes: BTreeMap<String, Note>,
    /// 小写文件名（不含扩展名）→ 相对路径
    by_stem: HashMap<String, Vec<String>>,
    /// 小写相对路径（不含扩展名）→ 相对路径
    by_path: HashMap<String, String>,
}

fn stem_of(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name.to_string(),
    }
}

fn without_ext(rel: &str) -> &str {
    let name_start = rel.rfind('/').map_or(0, |i| i + 1);
    match rel[name_start..].rfind('.') {
        Some(i) if i > 0 => &rel[..name_start + i],
        _ => rel,
    }
}

fn dir_of(rel: &str) -> &str {
    rel.rfind('/').map_or("", |i| &rel[..i])
}

/// 把 `dir` 和相对路径拼起来，处理 `.` 和 `..`；跑出库根目录时返回 None
fn join_rel(dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = if rel.starts_with('/') {
        vec![]
    } else {
        dir.split('/').filter(|s| !s.is_empty()).collect()
    };
    for seg in rel.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

/// 截取一行里提及前后的文字，按字符截，不切坏 UTF-8
fn context_around(line: &str, at: usize) -> String {
    const MAX: usize = 120;
    let line = line.trim_end();
    if line.chars().count() <= MAX {
        return line.trim().to_string();
    }
    let before: Vec<char> = line[..at.min(line.len())].chars().collect();
    let start = before.len().saturating_sub(40);
    let s: String = line.chars().skip(start).take(MAX).collect();
    format!("{}{}…", if start > 0 { "…" } else { "" }, s.trim())
}

/// 命中处的上下文：每行只取第一处，最多 max 行。pos 是（字节偏移，长度），已排序
fn snippets(text: &str, pos: &[(usize, usize)], max: usize) -> Vec<SearchMatch> {
    let mut out: Vec<SearchMatch> = Vec::new();
    let mut last_line = usize::MAX;
    for &(at, len) in pos {
        let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
        let line_no = text[..line_start].matches('\n').count();
        if line_no == last_line {
            continue;
        }
        last_line = line_no;
        let line_end = text[at..].find('\n').map_or(text.len(), |i| at + i);
        let end = (at + len).min(line_end);
        if !text.is_char_boundary(at) || !text.is_char_boundary(end) {
            continue;
        }
        let before: Vec<char> = text[line_start..at].chars().collect();
        let before: String = before[before.len().saturating_sub(30)..].iter().collect();
        let after: String = text[end..line_end]
            .trim_end_matches('\r')
            .chars()
            .take(60)
            .collect();
        out.push(SearchMatch {
            line: line_no,
            before: before.trim_start().to_string(),
            text: text[at..end].to_string(),
            after,
        });
        if out.len() >= max {
            break;
        }
    }
    out
}

/// 代码所在的字节区间：和遮住代码后的文字逐字节比较，不同的地方就是代码
fn code_ranges(text: &str) -> Vec<(usize, usize)> {
    let masked = mask_code(text);
    let mut out: Vec<(usize, usize)> = Vec::new();
    for (i, (a, b)) in text.bytes().zip(masked.bytes()).enumerate() {
        if a != b {
            match out.last_mut() {
                Some(last) if last.1 == i => last.1 = i + 1,
                _ => out.push((i, i + 1)),
            }
        }
    }
    out
}

fn in_ranges(ranges: &[(usize, usize)], at: usize, len: usize) -> bool {
    ranges.iter().any(|&(s, e)| at < e && s < at + len)
}

/// 名字在文字里第一次出现（不在代码里）的位置；英文名字要整词匹配（"plan" 不算 "planning"）
fn first_mention(lower: &str, code: &[(usize, usize)], name: &str) -> Option<usize> {
    let word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let at = from + i;
        from = at + name.len();
        if name.is_ascii()
            && (word(lower[..at].chars().next_back())
                || word(lower[at + name.len()..].chars().next()))
            || in_ranges(code, at, name.len())
        {
            continue;
        }
        return Some(at);
    }
    None
}

impl Index {
    /// 遍历库，读入所有 Markdown 文件
    pub fn build(root: &Path) -> io::Result<Self> {
        let mut index = Index {
            root: root.to_path_buf(),
            ..Default::default()
        };
        for rel in vault::list_markdown(root, vault::DEFAULT_LIMIT)? {
            if let Ok(text) = fs::read_to_string(root.join(&rel)) {
                index.insert(rel, text);
            }
        }
        Ok(index)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn len(&self) -> usize {
        self.notes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.notes.is_empty()
    }

    /// 绝对路径 → 相对路径（`/` 分隔）；不在库里或不是 Markdown 返回 None
    pub fn rel_of(&self, abs: &Path) -> Option<String> {
        let r = abs.strip_prefix(&self.root).ok()?;
        let parts: Vec<_> = r
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let rel = parts.join("/");
        // .zyrite/snapshots 里的基线也是 .md，不能当成笔记
        if vault::is_hidden_rel(&rel) {
            return None;
        }
        (!rel.is_empty() && is_markdown_path(&rel)).then_some(rel)
    }

    pub fn insert(&mut self, rel: String, text: String) {
        self.remove(&rel);
        let stem = stem_of(&rel);
        self.by_stem
            .entry(stem.to_lowercase())
            .or_default()
            .push(rel.clone());
        self.by_path
            .insert(without_ext(&rel).to_lowercase(), rel.clone());
        let lower = text.to_ascii_lowercase();
        let code = code_ranges(&text);
        let meta = extract(&text);
        self.notes.insert(
            rel.clone(),
            Note {
                rel,
                stem,
                meta,
                text,
                lower,
                code,
            },
        );
    }

    /// 所有笔记的相对路径和全文（问答检索切块用）
    pub fn texts(&self) -> impl Iterator<Item = (&str, &str)> {
        self.notes
            .values()
            .map(|n| (n.rel.as_str(), n.text.as_str()))
    }

    /// 索引里记着的这篇笔记的全文（文件被外部改写之前的版本，用来补建审阅基线）
    pub fn text_of(&self, rel: &str) -> Option<&str> {
        self.notes.get(rel).map(|n| n.text.as_str())
    }

    pub fn remove(&mut self, rel: &str) {
        if self.notes.remove(rel).is_none() {
            return;
        }
        let key = stem_of(rel).to_lowercase();
        if let Some(v) = self.by_stem.get_mut(&key) {
            v.retain(|r| r != rel);
            if v.is_empty() {
                self.by_stem.remove(&key);
            }
        }
        self.by_path.remove(&without_ext(rel).to_lowercase());
    }

    /// 文件监听报告某个文件变了：重新读入，读不到就移除。返回是否影响索引
    pub fn refresh(&mut self, abs: &Path) -> bool {
        let Some(rel) = self.rel_of(abs) else {
            return false;
        };
        // 被忽略的路径（隐藏目录、.zyriteignore）由监听层过滤，这里不再判断
        match fs::read_to_string(abs) {
            Ok(text) => self.insert(rel, text),
            Err(_) => self.remove(&rel),
        }
        true
    }

    /// 一个文件夹被删或移走：移除它下面的所有笔记
    pub fn remove_dir(&mut self, abs: &Path) {
        let Ok(r) = abs.strip_prefix(&self.root) else {
            return;
        };
        let prefix = format!(
            "{}/",
            r.components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        );
        let gone: Vec<String> = self
            .notes
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        for rel in gone {
            self.remove(&rel);
        }
    }

    /// 按文件监听报告的一批变化更新索引，返回是否有变化。
    /// 文件夹新建或改名时监听只报告文件夹本身，所以要把它下面的文件重新扫一遍；删除时连同整个前缀移除。
    pub fn apply_changes(&mut self, changes: &[Change]) -> bool {
        let mut changed = false;
        for c in changes {
            let path = Path::new(&c.path);
            if c.kind == ChangeKind::Remove {
                changed |= self.refresh(path);
                let before = self.notes.len();
                self.remove_dir(path);
                changed |= self.notes.len() != before;
            } else if c.dir {
                for rel in vault::list_markdown(path, vault::DEFAULT_LIMIT).unwrap_or_default() {
                    changed |= self.refresh(&path.join(rel));
                }
            } else {
                changed |= self.refresh(path);
            }
        }
        changed
    }

    pub fn resolve_target(&self, kind: LinkKind, target: &str, from: &str) -> Resolved {
        let t = target.trim();
        if t.is_empty() {
            return Resolved::Other; // [[#标题]] 指向自己
        }
        match kind {
            LinkKind::Markdown => match join_rel(dir_of(from), t) {
                Some(rel) => match self.by_path.get(&without_ext(&rel).to_lowercase()) {
                    Some(r) => Resolved::Note { rel: r.clone() },
                    None => Resolved::Missing,
                },
                None => Resolved::Other,
            },
            LinkKind::Wiki => {
                let name = t.rsplit('/').next().unwrap_or(t);
                let has_other_ext =
                    name.rfind('.').is_some_and(|i| i > 0) && !is_markdown_path(name);
                // 带非 Markdown 扩展名的是附件；但 "v1.2 计划" 这类名字里的点不算扩展名
                if has_other_ext
                    && name.rsplit('.').next().is_some_and(|e| {
                        e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric())
                    })
                {
                    return Resolved::Other;
                }
                let t = if is_markdown_path(t) {
                    without_ext(t)
                } else {
                    t
                };
                if t.contains('/') {
                    for base in [dir_of(from), ""] {
                        if let Some(rel) = join_rel(base, t) {
                            if let Some(r) = self.by_path.get(&rel.to_lowercase()) {
                                return Resolved::Note { rel: r.clone() };
                            }
                        }
                    }
                    return Resolved::Missing;
                }
                match self.by_stem.get(&t.to_lowercase()) {
                    Some(cands) if !cands.is_empty() => {
                        let here = dir_of(from);
                        let best = cands
                            .iter()
                            .min_by_key(|r| (dir_of(r) != here, r.len(), (*r).clone()))
                            .cloned()
                            .unwrap_or_default();
                        Resolved::Note { rel: best }
                    }
                    _ => Resolved::Missing,
                }
            }
        }
    }

    pub fn resolve(&self, link: &Link, from: &str) -> Resolved {
        self.resolve_target(link.kind, &link.target, from)
    }

    /// 双链补全用的笔记名单
    pub fn names(&self) -> Vec<NoteName> {
        self.notes
            .values()
            .map(|n| NoteName {
                rel: n.rel.clone(),
                stem: n.stem.clone(),
                title: n.meta.title.clone(),
                aliases: n.meta.aliases.clone(),
            })
            .collect()
    }

    /// 指向 rel 的链接（含上下文）
    pub fn backlinks(&self, rel: &str) -> Vec<Mention> {
        let mut out = Vec::new();
        for note in self.notes.values() {
            if note.rel == rel {
                continue;
            }
            for link in &note.meta.links {
                if self.resolve(link, &note.rel)
                    == (Resolved::Note {
                        rel: rel.to_string(),
                    })
                {
                    let line = note.text.lines().nth(link.line).unwrap_or("");
                    out.push(Mention {
                        from: note.rel.clone(),
                        line: link.line,
                        context: context_around(line, link.start),
                    });
                }
            }
        }
        out
    }

    /// 提到了 rel 的文件名、标题或别名、但没有链接过去的地方
    pub fn unlinked(&self, rel: &str, limit: usize) -> Vec<Mention> {
        let Some(target) = self.notes.get(rel) else {
            return vec![];
        };
        let mut names: Vec<String> = std::iter::once(target.stem.clone())
            .chain(target.meta.title.clone())
            .chain(target.meta.aliases.iter().cloned())
            .map(|s| s.to_ascii_lowercase())
            .filter(|s| s.chars().count() >= 2)
            .collect();
        names.sort();
        names.dedup();
        let linked: HashSet<String> = self.backlinks(rel).into_iter().map(|m| m.from).collect();
        let mut out = Vec::new();
        for note in self.notes.values() {
            if note.rel == rel || linked.contains(&note.rel) {
                continue;
            }
            // 所有名字里最早出现的那一处；每篇笔记只列一次
            let Some(at) = names
                .iter()
                .filter_map(|name| first_mention(&note.lower, &note.code, name))
                .min()
            else {
                continue;
            };
            let line_no = note.text[..at].matches('\n').count();
            let line_start = note.text[..at].rfind('\n').map_or(0, |p| p + 1);
            let line = note.text[line_start..].lines().next().unwrap_or("");
            out.push(Mention {
                from: note.rel.clone(),
                line: line_no,
                context: context_around(line, at - line_start),
            });
            if out.len() >= limit {
                break;
            }
        }
        out
    }

    /// 标签和笔记数；和 Obsidian 一样不区分大小写，显示第一次出现的写法
    pub fn tags(&self) -> Vec<TagCount> {
        let mut counts: BTreeMap<String, (String, usize)> = BTreeMap::new();
        for note in self.notes.values() {
            let mut seen = HashSet::new();
            for t in &note.meta.tags {
                let key = t.to_lowercase();
                if seen.insert(key.clone()) {
                    counts.entry(key).or_insert_with(|| (t.clone(), 0)).1 += 1;
                }
            }
        }
        counts
            .into_values()
            .map(|(tag, count)| TagCount { tag, count })
            .collect()
    }

    /// 有这个标签（或它的子标签 `tag/…`）的笔记
    pub fn notes_with_tag(&self, tag: &str) -> Vec<String> {
        let tag = tag.trim_start_matches('#').to_lowercase();
        let prefix = format!("{tag}/");
        self.notes
            .values()
            .filter(|n| {
                n.meta.tags.iter().any(|t| {
                    let t = t.to_lowercase();
                    t == tag || t.starts_with(&prefix)
                })
            })
            .map(|n| n.rel.clone())
            .collect()
    }

    /// 全文搜索，查询语法见 search 模块。返回命中最多的前 limit 篇，每篇最多 3 处上下文
    pub fn search(&self, query: &str, limit: usize) -> SearchResult {
        let started = std::time::Instant::now();
        let q = search::parse(query);
        if q.is_empty() {
            return SearchResult::default();
        }
        let tag_notes: Option<HashSet<String>> = (!q.tags.is_empty())
            .then(|| q.tags.iter().flat_map(|t| self.notes_with_tag(t)).collect());
        // 第一遍只计数打分，不收集位置；上下文只给排在前面的 limit 篇生成
        let mut scored: Vec<(usize, &Note, usize)> = Vec::new(); // 分数、笔记、命中数
        let mut total_matches = 0;
        'notes: for note in self.notes.values() {
            if !q.folders.is_empty()
                && !q.folders.iter().any(|f| {
                    note.rel
                        .to_lowercase()
                        .starts_with(&format!("{}/", f.to_lowercase()))
                })
            {
                continue;
            }
            if tag_notes.as_ref().is_some_and(|t| !t.contains(&note.rel)) {
                continue;
            }
            for ex in &q.exclude {
                if note.lower.contains(ex.as_str()) {
                    continue 'notes;
                }
            }
            let stem = note.stem.to_ascii_lowercase();
            let title = note
                .meta
                .title
                .as_deref()
                .unwrap_or("")
                .to_ascii_lowercase();
            let mut score = 0;
            let mut count = 0;
            for term in &q.terms {
                let n = note.lower.matches(term.as_str()).count();
                if n == 0 {
                    continue 'notes;
                }
                count += n;
                score += n.min(10);
                if stem.contains(term.as_str()) {
                    score += 20;
                }
                if title.contains(term.as_str()) {
                    score += 10;
                }
            }
            total_matches += count;
            scored.push((score, note, count));
        }
        let total_notes = scored.len();
        let cmp = |a: &(usize, &Note, usize), b: &(usize, &Note, usize)| {
            b.0.cmp(&a.0).then_with(|| a.1.rel.cmp(&b.1.rel))
        };
        if scored.len() > limit {
            scored.select_nth_unstable_by(limit, cmp);
            scored.truncate(limit);
        }
        scored.sort_by(cmp);
        let hits = scored
            .into_iter()
            .map(|(_, note, count)| {
                let mut pos: Vec<(usize, usize)> = q
                    .terms
                    .iter()
                    .flat_map(|t| {
                        note.lower
                            .match_indices(t.as_str())
                            .map(move |(i, _)| (i, t.len()))
                    })
                    .collect();
                pos.sort_unstable();
                SearchHit {
                    rel: note.rel.clone(),
                    title: note.meta.title.clone(),
                    count,
                    matches: snippets(&note.text, &pos, 3),
                }
            })
            .collect();
        SearchResult {
            hits,
            total_notes,
            total_matches,
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    }

    /// 改名或移动 `from`（文件或文件夹，相对路径）到 `to` 之后，要改写的链接。
    /// 必须在改名之前、用改名前的索引计算。返回的文件路径是改名之后的相对路径。
    pub fn plan_rename(&self, from: &str, to: &str) -> RenamePlan {
        let from = from.trim_end_matches('/');
        let to = to.trim_end_matches('/');
        // 受影响的笔记：旧路径 → 新路径
        let prefix = format!("{from}/");
        let moved: HashMap<&str, String> = self
            .notes
            .keys()
            .filter_map(|r| {
                if r == from {
                    Some((r.as_str(), to.to_string()))
                } else {
                    r.strip_prefix(&prefix)
                        .map(|rest| (r.as_str(), format!("{to}/{rest}")))
                }
            })
            .collect();
        if moved.is_empty() {
            return RenamePlan::default();
        }
        // 改名之后每个文件名有几篇，决定双链写文件名还是写路径
        let mut stems: HashMap<String, usize> = HashMap::new();
        for r in self.notes.keys() {
            let after = moved.get(r.as_str()).cloned().unwrap_or_else(|| r.clone());
            *stems.entry(stem_of(&after).to_lowercase()).or_default() += 1;
        }

        let mut plan = RenamePlan::default();
        for note in self.notes.values() {
            let note_moved = moved.get(note.rel.as_str());
            let note_after = note_moved.cloned().unwrap_or_else(|| note.rel.clone());
            let mut edits: Vec<(usize, usize, usize, String)> = Vec::new(); // 行、起、止、新文字
            for link in &note.meta.links {
                let Resolved::Note { rel: target } = self.resolve(link, &note.rel) else {
                    continue;
                };
                let target_after = moved
                    .get(target.as_str())
                    .cloned()
                    .unwrap_or_else(|| target.clone());
                let Some(line) = note.text.lines().nth(link.line) else {
                    continue;
                };
                let Some(original) = line.get(link.start..link.end) else {
                    continue;
                };
                let replacement = match link.kind {
                    LinkKind::Wiki => {
                        // 目标没动、笔记自己也没动（或目标写的是文件名）就不用改
                        if target_after == target
                            && (note_moved.is_none() || !link.target.contains('/'))
                        {
                            continue;
                        }
                        let unique = stems
                            .get(&stem_of(&target_after).to_lowercase())
                            .copied()
                            .unwrap_or(0)
                            <= 1;
                        let mut new_target = if unique {
                            stem_of(&target_after)
                        } else {
                            without_ext(&target_after).to_string()
                        };
                        if is_markdown_path(&link.target) {
                            new_target.push_str(&target_after[without_ext(&target_after).len()..]);
                        }
                        rewrite_wiki(original, &new_target)
                    }
                    LinkKind::Markdown => {
                        if target_after == target && note_moved.is_none() {
                            continue;
                        }
                        let rel = relative_path(dir_of(&note_after), &target_after);
                        rewrite_markdown(original, &rel)
                    }
                };
                if let Some(r) = replacement.filter(|r| r != original) {
                    edits.push((link.line, link.start, link.end, r));
                }
            }
            if edits.is_empty() {
                continue;
            }
            plan.links += edits.len();
            plan.files
                .push((note_after, apply_edits(&note.text, edits)));
        }
        plan
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RenamePlan {
    /// 要改写的笔记（改名之后的相对路径）和改写后的全文
    pub files: Vec<(String, String)>,
    /// 改写的链接总数
    pub links: usize,
}

/// `[[旧#标题|别名]]` → `[[新#标题|别名]]`，`!`、标题、别名原样保留
fn rewrite_wiki(original: &str, new_target: &str) -> Option<String> {
    let open = original.find("[[")?;
    let inner = original.get(open + 2..original.len() - 2)?;
    let cut = inner.find(['|', '#']).unwrap_or(inner.len());
    Some(format!(
        "{}[[{}{}]]",
        &original[..open],
        new_target,
        &inner[cut..]
    ))
}

/// `[文字](旧.md#锚点 "标题")` → `[文字](新.md#锚点 "标题")`
fn rewrite_markdown(original: &str, new_path: &str) -> Option<String> {
    let paren = original.rfind("](")? + 2;
    let rest = &original[paren..original.len() - 1];
    let lead = rest.len() - rest.trim_start().len();
    let body = rest.trim_start();
    let (url, tail) = if let Some(stripped) = body.strip_prefix('<') {
        let close = stripped.find('>')?;
        (&stripped[..close], &stripped[close + 1..])
    } else {
        let end = body.find(char::is_whitespace).unwrap_or(body.len());
        (&body[..end], &body[end..])
    };
    let anchor = url.find(['#', '?']).map_or("", |i| &url[i..]);
    let encoded: String = new_path
        .chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '(' => "%28".to_string(),
            ')' => "%29".to_string(),
            '<' => "%3C".to_string(),
            '>' => "%3E".to_string(),
            c => c.to_string(),
        })
        .collect();
    Some(format!(
        "{}{}{}{}{})",
        &original[..paren],
        &rest[..lead],
        encoded,
        anchor,
        tail
    ))
}

/// 两个库内相对路径之间的相对路径：从 `from_dir` 到 `to`
fn relative_path(from_dir: &str, to: &str) -> String {
    let a: Vec<&str> = from_dir.split('/').filter(|s| !s.is_empty()).collect();
    let b: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut parts: Vec<&str> = std::iter::repeat_n("..", a.len() - common).collect();
    parts.extend(&b[common..]);
    parts.join("/")
}

/// 按行和字节区间替换，从后往前改，不影响前面的偏移；保留原来的换行符
fn apply_edits(text: &str, mut edits: Vec<(usize, usize, usize, String)>) -> String {
    edits.sort_by_key(|e| std::cmp::Reverse((e.0, e.1)));
    let mut lines: Vec<String> = text.split_inclusive('\n').map(str::to_string).collect();
    for (line, start, end, new) in edits {
        if let Some(l) = lines.get_mut(line) {
            if l.is_char_boundary(start) && l.is_char_boundary(end) && end <= l.len() {
                l.replace_range(start..end, &new);
            }
        }
    }
    lines.concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(files: &[(&str, &str)]) -> (tempfile::TempDir, Index) {
        let dir = tempfile::tempdir().unwrap();
        for (p, text) in files {
            let full = dir.path().join(p);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, text).unwrap();
        }
        let index = Index::build(dir.path()).unwrap();
        (dir, index)
    }

    fn rel(r: &Resolved) -> &str {
        match r {
            Resolved::Note { rel } => rel,
            Resolved::Missing => "<missing>",
            Resolved::Other => "<other>",
        }
    }

    #[test]
    fn 双链解析() {
        let (_d, ix) = vault(&[
            ("plan.md", ""),
            ("docs/plan.md", ""),
            ("docs/deep/arch.md", ""),
            ("notes/a.md", ""),
            ("v1.2 计划.md", ""),
        ]);
        let w = |t: &str, from: &str| rel(&ix.resolve_target(LinkKind::Wiki, t, from)).to_string();
        assert_eq!(w("plan", "notes/a.md"), "plan.md"); // 路径最短
        assert_eq!(w("Plan", "docs/x.md"), "docs/plan.md"); // 同一文件夹优先，不区分大小写
        assert_eq!(w("plan.md", "notes/a.md"), "plan.md");
        assert_eq!(w("arch", "notes/a.md"), "docs/deep/arch.md");
        assert_eq!(w("deep/arch", "docs/x.md"), "docs/deep/arch.md"); // 相对当前笔记
        assert_eq!(w("docs/deep/arch", "notes/a.md"), "docs/deep/arch.md"); // 相对库根目录
        assert_eq!(w("v1.2 计划", "a.md"), "v1.2 计划.md");
        assert_eq!(w("不存在", "a.md"), "<missing>");
        assert_eq!(w("图.png", "a.md"), "<other>");
        let m =
            |t: &str, from: &str| rel(&ix.resolve_target(LinkKind::Markdown, t, from)).to_string();
        assert_eq!(m("../plan.md", "docs/x.md"), "plan.md");
        assert_eq!(m("deep/ARCH.md", "docs/x.md"), "docs/deep/arch.md");
        assert_eq!(m("../../outside.md", "docs/x.md"), "<other>");
        assert_eq!(m("missing.md", "docs/x.md"), "<missing>");
    }

    #[test]
    fn 反向链接和未链接提及() {
        let (_d, ix) = vault(&[
            ("zyrite-方案.md", "---\naliases: [纸砚方案]\n---\n# 方案\n"),
            ("竞品调研.md", "差异点写进 [[zyrite-方案]] 的定位一节。\n"),
            ("日记.md", "今天定了名字，见 [方案](zyrite-方案.md)。\n"),
            (
                "杂记.md",
                "提了一句纸砚方案，但没有链接。\n\n```\n[[zyrite-方案]] 在代码里不算\n```\n",
            ),
            ("other.md", "zyrite-方案x 也算提及（中文名不要求整词）\n"),
        ]);
        let back = ix.backlinks("zyrite-方案.md");
        assert_eq!(
            back.iter().map(|m| m.from.as_str()).collect::<Vec<_>>(),
            vec!["日记.md", "竞品调研.md"]
        );
        assert_eq!(back[1].context, "差异点写进 [[zyrite-方案]] 的定位一节。");
        let un = ix.unlinked("zyrite-方案.md", 50);
        assert_eq!(
            un.iter().map(|m| m.from.as_str()).collect::<Vec<_>>(),
            vec!["other.md", "杂记.md"]
        );
        assert_eq!(un[1].line, 0);
    }

    #[test]
    fn 英文名整词匹配() {
        let (_d, ix) = vault(&[
            ("plan.md", ""),
            (
                "a.md",
                "the planner is not a plan mention? yes it is: plan.\n",
            ),
            ("b.md", "planning\n"),
        ]);
        let un = ix.unlinked("plan.md", 50);
        assert_eq!(
            un.iter().map(|m| m.from.as_str()).collect::<Vec<_>>(),
            vec!["a.md"]
        );
    }

    #[test]
    fn 标签统计和查询() {
        let (_d, ix) = vault(&[
            ("a.md", "#project/zyrite #agent"),
            ("b.md", "---\ntags: [project]\n---\n#Agent"),
            ("c.md", "#project/other"),
        ]);
        let tags: Vec<_> = ix.tags().into_iter().map(|t| (t.tag, t.count)).collect();
        assert_eq!(
            tags,
            vec![
                ("agent".into(), 2),
                ("project".into(), 1),
                ("project/other".into(), 1),
                ("project/zyrite".into(), 1)
            ]
        );
        assert_eq!(ix.notes_with_tag("project"), vec!["a.md", "b.md", "c.md"]);
        assert_eq!(ix.notes_with_tag("#agent"), vec!["a.md", "b.md"]);
    }

    #[test]
    fn 按监听事件更新_文件夹改名() {
        let (d, mut ix) = vault(&[("a.md", "[[c]]"), ("old/c.md", "")]);
        let root = d.path();
        fs::rename(root.join("old"), root.join("new")).unwrap();
        let changes = vec![
            Change {
                path: root.join("old").display().to_string(),
                kind: ChangeKind::Remove,
                dir: false,
            },
            Change {
                path: root.join("new").display().to_string(),
                kind: ChangeKind::Create,
                dir: true,
            },
        ];
        assert!(ix.apply_changes(&changes));
        assert_eq!(ix.backlinks("new/c.md").len(), 1);
        assert!(ix.backlinks("old/c.md").is_empty());
        assert!(!ix.apply_changes(&[Change {
            path: root.join("x.png").display().to_string(),
            kind: ChangeKind::Create,
            dir: false
        }]));
    }

    fn plan_map(plan: &RenamePlan) -> BTreeMap<String, String> {
        plan.files.iter().cloned().collect()
    }

    #[test]
    fn 改名_更新双链和相对链接() {
        let (_d, ix) = vault(&[
            ("docs/plan.md", "# 方案\n见 [B](../notes/b.md#x)\n"),
            ("notes/a.md", "看 [[plan]]、[[plan#定位|方案]]、![[plan]] 和 [方案](../docs/plan.md \"标题\")\r\n第二行 [[plan]]\r\n"),
            ("notes/b.md", "无关 [[a]]\n"),
        ]);
        let plan = ix.plan_rename("docs/plan.md", "docs/roadmap 2026.md");
        assert_eq!(plan.links, 5);
        let m = plan_map(&plan);
        assert_eq!(
            m["notes/a.md"],
            "看 [[roadmap 2026]]、[[roadmap 2026#定位|方案]]、![[roadmap 2026]] 和 [方案](../docs/roadmap%202026.md \"标题\")\r\n第二行 [[roadmap 2026]]\r\n"
        );
        assert!(!m.contains_key("notes/b.md"));
    }

    #[test]
    fn 移动笔记_自己往外的相对链接也要改() {
        let (_d, ix) = vault(&[
            ("docs/plan.md", "见 [B](../notes/b.md#x) 和 [[b]]\n"),
            ("notes/b.md", "回到 [plan](../docs/plan.md)\n"),
        ]);
        let plan = ix.plan_rename("docs/plan.md", "archive/2026/plan.md");
        let m = plan_map(&plan);
        // 被移动的笔记自己：相对链接重算，按文件名的双链不用改
        assert_eq!(
            m["archive/2026/plan.md"],
            "见 [B](../../notes/b.md#x) 和 [[b]]\n"
        );
        assert_eq!(m["notes/b.md"], "回到 [plan](../archive/2026/plan.md)\n");
        assert_eq!(plan.links, 2);
    }

    #[test]
    fn 文件夹改名_重名时写路径() {
        let (_d, ix) = vault(&[
            ("old/plan.md", ""),
            ("old/x.md", "[[plan]] [[old/x]]\n"),
            ("a.md", "[[old/plan]] [[x]]\n"),
            ("other/x.md", ""),
        ]);
        let plan = ix.plan_rename("old", "new");
        let m = plan_map(&plan);
        // x 在库里重名，所以写路径；plan 唯一，写文件名
        assert_eq!(m["a.md"], "[[plan]] [[new/x]]\n");
        assert_eq!(m["new/x.md"], "[[plan]] [[new/x]]\n");
    }

    #[test]
    fn 没有指向它的链接_不改() {
        let (_d, ix) = vault(&[("a.md", "[[b]]"), ("c.md", "")]);
        assert_eq!(ix.plan_rename("c.md", "d.md"), RenamePlan::default());
        assert_eq!(ix.plan_rename("nope.md", "d.md"), RenamePlan::default());
    }

    #[test]
    fn 全文搜索() {
        let (_d, ix) = vault(&[
            (
                "docs/审阅流程.md",
                "# 审阅流程\n\n逐段审阅 Agent 写入的改动。\n第二处：审阅完成。\n",
            ),
            ("docs/草稿.md", "这里也提到审阅，但是是草稿。\n"),
            (
                "notes/agent.md",
                "---\ntags: [agent]\n---\nAGENT 写入时要审阅。\n```\n代码里的审阅也算\n```\n",
            ),
            ("notes/other.md", "无关\n"),
        ]);
        let r = ix.search("审阅", 10);
        assert_eq!(r.total_notes, 3);
        // 文件名命中的排在前面
        assert_eq!(r.hits[0].rel, "docs/审阅流程.md");
        assert_eq!(r.hits[0].count, 3);
        let m = &r.hits[0].matches;
        assert_eq!(m.len(), 3);
        assert_eq!(
            (
                m[1].line,
                m[1].before.as_str(),
                m[1].text.as_str(),
                m[1].after.as_str()
            ),
            (2, "逐段", "审阅", " Agent 写入的改动。")
        );
        // 排除词、短语（不区分英文大小写）、文件夹、标签
        assert_eq!(ix.search("审阅 -草稿", 10).total_notes, 2);
        assert_eq!(
            ix.search("\"agent 写入\"", 10)
                .hits
                .iter()
                .map(|h| h.rel.as_str())
                .collect::<Vec<_>>(),
            vec!["docs/审阅流程.md", "notes/agent.md"]
        );
        assert_eq!(ix.search("审阅 path:notes", 10).total_notes, 1);
        assert_eq!(ix.search("审阅 #agent", 10).hits[0].rel, "notes/agent.md");
        assert_eq!(ix.search("#agent", 10).total_notes, 1);
        assert_eq!(ix.search("不存在的词", 10).total_notes, 0);
        assert_eq!(ix.search("  ", 10), SearchResult::default());
    }

    #[test]
    fn 增量更新() {
        let (d, mut ix) = vault(&[("a.md", "[[b]]"), ("sub/c.md", "")]);
        assert_eq!(
            ix.resolve_target(LinkKind::Wiki, "b", "a.md"),
            Resolved::Missing
        );
        fs::write(d.path().join("b.md"), "# B").unwrap();
        assert!(ix.refresh(&d.path().join("b.md")));
        assert_eq!(ix.backlinks("b.md").len(), 1);
        fs::remove_file(d.path().join("b.md")).unwrap();
        ix.refresh(&d.path().join("b.md"));
        assert!(ix.backlinks("b.md").is_empty());
        assert!(!ix.refresh(&d.path().join("image.png")));
        // .zyrite 里的基线不是笔记
        fs::create_dir_all(d.path().join(".zyrite/snapshots")).unwrap();
        fs::write(d.path().join(".zyrite/snapshots/a.md"), "[[b]]").unwrap();
        assert!(!ix.refresh(&d.path().join(".zyrite/snapshots/a.md")));
        ix.remove_dir(&d.path().join("sub"));
        assert_eq!(ix.len(), 1);
    }

    /// 1 万篇笔记的耗时。手动运行：
    /// cargo test -p zyrite-core --release -- --ignored --nocapture 一万篇
    #[test]
    #[ignore]
    fn 性能_一万篇() {
        use std::time::Instant;
        let dir = tempfile::tempdir().unwrap();
        let para =
            "这是一段用来凑长度的正文，提到了 note-42 但没有链接。Lorem ipsum dolor sit amet. "
                .repeat(20);
        for i in 0..10_000 {
            let sub = dir.path().join(format!("d{}", i % 50));
            fs::create_dir_all(&sub).unwrap();
            let text = format!(
                "---\ntags: [t{}]\n---\n# 笔记 {i}\n\n{para}\n\n链接 [[note-{}]] 和 [[note-{}|别名]] #tag{}/sub\n\n```\ncode [[x]]\n```\n",
                i % 100,
                (i + 1) % 10_000,
                (i * 7) % 10_000,
                i % 30
            );
            fs::write(sub.join(format!("note-{i}.md")), text).unwrap();
        }
        let t = Instant::now();
        let tree = crate::vault::list_tree(dir.path(), false, crate::vault::DEFAULT_LIMIT).unwrap();
        let tree_time = t.elapsed();
        assert_eq!(tree.len(), 10_050);
        let t = Instant::now();
        let ix = Index::build(dir.path()).unwrap();
        let build = t.elapsed();
        assert_eq!(ix.len(), 10_000);
        let rel = "d42/note-42.md";
        let t = Instant::now();
        let back = ix.backlinks(rel);
        let backlinks = t.elapsed();
        let t = Instant::now();
        let un = ix.unlinked(rel, 50);
        let unlinked = t.elapsed();
        let t = Instant::now();
        let found = ix.search("凑长度 note-42", 50);
        let search_time = t.elapsed();
        let t = Instant::now();
        let first_char = ix.search("凑", 50);
        let first_char_time = t.elapsed();
        let t = Instant::now();
        let tags = ix.tags();
        let tag_time = t.elapsed();
        println!(
            "文件树 {tree_time:?}；建索引 {build:?}；反向链接 {backlinks:?}（{} 条）；未链接提及 {unlinked:?}（{} 条）；标签 {tag_time:?}（{} 个）；\
             搜索两个词 {search_time:?}（{} 篇）；搜索单字 {first_char_time:?}（{} 篇）",
            back.len(),
            un.len(),
            tags.len(),
            found.total_notes,
            first_char.total_notes
        );
    }
}
