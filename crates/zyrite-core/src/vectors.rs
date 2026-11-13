//! "问问这个库"的本地检索：按标题和段落切块，向量存在本地 `.zyrite/vectors/`。
//!
//! 只负责切块、存取和相似度检索；向量由 zyrite-ai 调用用户配置的向量模型生成。
//! 文件格式：`meta.json`（模型、维数、每块的位置和内容哈希）+ `data.f32`（所有向量依次排列，小端 f32）。
//! 更新时按内容哈希复用已有的向量，只给新增或改过的块调用模型。

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::files::write_atomic;
use crate::store::DIR;

/// 每块大约多少字符
pub const CHUNK_CHARS: usize = 800;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    /// 相对库根目录
    pub rel: String,
    /// 起始行（从 0 开始）
    pub line: usize,
    /// 所在的标题（没有标题时为空）
    pub heading: String,
    pub text: String,
}

/// FNV-1a 64：判断块的内容有没有变
pub fn hash(text: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// 切块：先按标题分节，节内按空行分段，段落攒到 CHUNK_CHARS 左右为一块；frontmatter 不要
pub fn chunk(rel: &str, text: &str) -> Vec<Chunk> {
    let lines: Vec<&str> = text.lines().collect();
    let mut start = 0;
    if lines.first().map(|l| l.trim_end()) == Some("---") {
        if let Some(end) = lines
            .iter()
            .skip(1)
            .position(|l| matches!(l.trim_end(), "---" | "..."))
        {
            start = end + 2;
        }
    }
    let mut out = Vec::new();
    let mut heading = String::new();
    let mut buf = String::new();
    let mut buf_line = start;
    let mut in_code = false;
    let mut flush = |buf: &mut String, buf_line: usize, heading: &str| {
        let t = buf.trim();
        if !t.is_empty() {
            out.push(Chunk {
                rel: rel.to_string(),
                line: buf_line,
                heading: heading.to_string(),
                text: t.to_string(),
            });
        }
        buf.clear();
    };
    for (i, line) in lines.iter().enumerate().skip(start) {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
        }
        let is_heading = !in_code
            && trimmed.starts_with('#')
            && trimmed.trim_start_matches('#').starts_with(' ');
        if is_heading {
            flush(&mut buf, buf_line, &heading);
            heading = trimmed.trim_start_matches('#').trim().to_string();
            buf_line = i;
            buf.push_str(line);
            buf.push('\n');
            continue;
        }
        // 空行处、已经够长：断开
        if !in_code && line.trim().is_empty() && buf.chars().count() >= CHUNK_CHARS {
            flush(&mut buf, buf_line, &heading);
            buf_line = i + 1;
            continue;
        }
        if buf.is_empty() {
            buf_line = i;
        }
        buf.push_str(line);
        buf.push('\n');
    }
    flush(&mut buf, buf_line, &heading);
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunkMeta {
    rel: String,
    line: usize,
    heading: String,
    hash: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    model: String,
    dims: usize,
    chunks: Vec<ChunkMeta>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub rel: String,
    pub line: usize,
    pub heading: String,
    pub score: f32,
}

/// 本地向量库
pub struct VectorStore {
    dir: PathBuf,
    meta: Meta,
    data: Vec<f32>,
}

fn normalize(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        for x in v {
            *x /= n;
        }
    }
}

impl VectorStore {
    /// 打开库的向量库；没有或模型不同时为空
    pub fn open(root: &Path, model: &str) -> Self {
        let dir = root.join(DIR).join("vectors");
        let meta: Meta = fs::read(dir.join("meta.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .filter(|m: &Meta| m.model == model)
            .unwrap_or_else(|| Meta {
                model: model.to_string(),
                ..Default::default()
            });
        let data: Vec<f32> = fs::read(dir.join("data.f32"))
            .map(|b| {
                b.as_chunks::<4>()
                    .0
                    .iter()
                    .map(|c| f32::from_le_bytes(*c))
                    .collect()
            })
            .unwrap_or_default();
        let ok = meta.dims > 0 && data.len() == meta.dims * meta.chunks.len();
        if ok {
            Self { dir, meta, data }
        } else {
            Self {
                dir,
                meta: Meta {
                    model: model.to_string(),
                    ..Default::default()
                },
                data: Vec::new(),
            }
        }
    }

    pub fn len(&self) -> usize {
        self.meta.chunks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.meta.chunks.is_empty()
    }

    /// 已有的向量：内容哈希 → 向量
    fn existing(&self) -> HashMap<u64, &[f32]> {
        let d = self.meta.dims;
        self.meta
            .chunks
            .iter()
            .enumerate()
            .map(|(i, c)| (c.hash, &self.data[i * d..(i + 1) * d]))
            .collect()
    }

    /// 还没有向量的块（需要调用模型的）
    pub fn missing<'a>(&self, chunks: &'a [Chunk]) -> Vec<&'a Chunk> {
        let have = self.existing();
        chunks
            .iter()
            .filter(|c| !have.contains_key(&hash(&c.text)))
            .collect()
    }

    /// 用当前所有块重建：已有的向量复用，新的从 fresh（哈希 → 向量）里取；拿不到向量的块跳过
    pub fn rebuild(&mut self, chunks: &[Chunk], fresh: &HashMap<u64, Vec<f32>>) -> io::Result<()> {
        let have = self.existing();
        let mut metas = Vec::new();
        let mut data = Vec::new();
        let mut dims = self.meta.dims;
        for c in chunks {
            let h = hash(&c.text);
            let v: Option<Vec<f32>> = have
                .get(&h)
                .map(|v| v.to_vec())
                .or_else(|| fresh.get(&h).cloned());
            let Some(mut v) = v else { continue };
            if dims == 0 {
                dims = v.len();
            }
            if v.len() != dims {
                continue;
            }
            normalize(&mut v);
            metas.push(ChunkMeta {
                rel: c.rel.clone(),
                line: c.line,
                heading: c.heading.clone(),
                hash: h,
            });
            data.extend(v);
        }
        self.meta = Meta {
            model: self.meta.model.clone(),
            dims,
            chunks: metas,
        };
        self.data = data;
        fs::create_dir_all(&self.dir)?;
        let bytes: Vec<u8> = self.data.iter().flat_map(|x| x.to_le_bytes()).collect();
        write_atomic(&self.dir.join("data.f32"), &bytes)?;
        write_atomic(
            &self.dir.join("meta.json"),
            &serde_json::to_vec(&self.meta).map_err(io::Error::other)?,
        )
    }

    /// 和 query 最相近的 k 块；prefix 限定范围（文件夹 `docs/` 或单个文件 `docs/a.md`）
    pub fn search(&self, query: &[f32], k: usize, prefix: Option<&str>) -> Vec<Hit> {
        let d = self.meta.dims;
        if d == 0 || query.len() != d {
            return Vec::new();
        }
        let mut q = query.to_vec();
        normalize(&mut q);
        let mut hits: Vec<Hit> = self
            .meta
            .chunks
            .iter()
            .enumerate()
            .filter(|(_, c)| prefix.is_none_or(|p| c.rel == p || c.rel.starts_with(p)))
            .map(|(i, c)| {
                let score = self.data[i * d..(i + 1) * d]
                    .iter()
                    .zip(&q)
                    .map(|(a, b)| a * b)
                    .sum();
                Hit {
                    rel: c.rel.clone(),
                    line: c.line,
                    heading: c.heading.clone(),
                    score,
                }
            })
            .collect();
        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
        hits.truncate(k);
        hits
    }
}

/// 没有向量模型时的检索：按问题里的词（英文按单词，中文按相邻两个字）在块里出现的次数打分
pub fn lexical_search<'a>(chunks: &'a [Chunk], query: &str, k: usize) -> Vec<(&'a Chunk, f32)> {
    let q = query.to_lowercase();
    let mut terms: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut cjk: Vec<char> = Vec::new();
    let flush_cjk = |cjk: &mut Vec<char>, terms: &mut Vec<String>| {
        if cjk.len() == 1 {
            terms.push(cjk[0].to_string());
        }
        for w in cjk.windows(2) {
            terms.push(w.iter().collect());
        }
        cjk.clear();
    };
    for ch in q.chars() {
        if ch.is_ascii_alphanumeric() {
            flush_cjk(&mut cjk, &mut terms);
            word.push(ch);
        } else {
            if word.chars().count() >= 2 {
                terms.push(std::mem::take(&mut word));
            }
            word.clear();
            if ch.is_alphanumeric() {
                cjk.push(ch);
            } else {
                flush_cjk(&mut cjk, &mut terms);
            }
        }
    }
    if word.chars().count() >= 2 {
        terms.push(word);
    }
    flush_cjk(&mut cjk, &mut terms);
    terms.sort();
    terms.dedup();
    if terms.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(&Chunk, f32)> = chunks
        .iter()
        .filter_map(|c| {
            let text = c.text.to_lowercase();
            let hits = terms.iter().filter(|t| text.contains(t.as_str())).count();
            (hits > 0).then(|| (c, hits as f32 / terms.len() as f32))
        })
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored.truncate(k);
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 切块_按标题和段落() {
        let long = "长段落。".repeat(250); // 1000 字
        let text = format!("---\ntitle: x\n---\n# 标题一\n\n第一段\n\n{long}\n\n第三段\n\n## 标题二\n\n```\n# 不是标题\n```\n");
        let c = chunk("a.md", &text);
        assert_eq!(
            c.iter().map(|c| c.heading.as_str()).collect::<Vec<_>>(),
            vec!["标题一", "标题一", "标题二"]
        );
        assert!(c[0].text.starts_with("# 标题一") && c[0].text.contains(&long));
        assert_eq!(c[1].text, "第三段");
        assert_eq!(c[0].line, 3);
        assert!(c[2].text.contains("# 不是标题"));
    }

    #[test]
    fn 没有向量模型时按词检索() {
        let chunks = vec![
            Chunk {
                rel: "a.md".into(),
                line: 0,
                heading: String::new(),
                text: "审阅流程：Agent 写入后逐段审阅".into(),
            },
            Chunk {
                rel: "b.md".into(),
                line: 0,
                heading: String::new(),
                text: "主题和配色".into(),
            },
        ];
        let r = lexical_search(&chunks, "怎么审阅 agent 的改动？", 5);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0.rel, "a.md");
        assert!(lexical_search(&chunks, "？！", 5).is_empty());
    }

    #[test]
    fn 存取_复用_检索() {
        let dir = tempfile::tempdir().unwrap();
        let chunks = vec![
            Chunk {
                rel: "docs/a.md".into(),
                line: 0,
                heading: "A".into(),
                text: "苹果".into(),
            },
            Chunk {
                rel: "notes/b.md".into(),
                line: 3,
                heading: "B".into(),
                text: "香蕉".into(),
            },
        ];
        let mut s = VectorStore::open(dir.path(), "m1");
        assert_eq!(s.missing(&chunks).len(), 2);
        let fresh: HashMap<u64, Vec<f32>> = [
            (hash("苹果"), vec![1.0, 0.0]),
            (hash("香蕉"), vec![0.0, 2.0]),
        ]
        .into_iter()
        .collect();
        s.rebuild(&chunks, &fresh).unwrap();

        let s = VectorStore::open(dir.path(), "m1");
        assert_eq!(s.len(), 2);
        assert!(s.missing(&chunks).is_empty());
        let hits = s.search(&[0.1, 1.0], 2, None);
        assert_eq!(hits[0].rel, "notes/b.md");
        assert_eq!(s.search(&[0.1, 1.0], 2, Some("docs/"))[0].rel, "docs/a.md");
        // 换了模型：重新开始
        assert!(VectorStore::open(dir.path(), "m2").is_empty());
    }
}
