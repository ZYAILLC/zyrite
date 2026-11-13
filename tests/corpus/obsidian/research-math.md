---
title: 检索打分笔记
---

# BM25 与向量混合打分

BM25 的单词项得分：

$$
\operatorname{score}(D, q_i) = \mathrm{IDF}(q_i) \cdot \frac{f(q_i, D) \cdot (k_1 + 1)}{f(q_i, D) + k_1 \cdot \left(1 - b + b \cdot \frac{|D|}{\mathrm{avgdl}}\right)}
$$

其中 $k_1 \in [1.2, 2.0]$，$b = 0.75$。价格是 $5 和 $10，这不是公式。

混合打分：$s = \alpha \cdot s_{\text{bm25}} + (1-\alpha) \cdot \cos(\vec{q}, \vec{d})$。

$$\alpha = 0.6$$

| 参数 | 取值 | 备注 |
|---|---|---|
| $k_1$ | 1.5 | 中文分词后偏短，取中间值 |
| $b$ | 0.75 | 默认 |

$$
\begin{aligned}
P(R \mid D) &\propto P(D \mid R) P(R) \\
&\approx \prod_i P(t_i \mid R)
\end{aligned}
$$

参考：Robertson & Zaragoza (2009)[^bm25]。

[^bm25]: *The Probabilistic Relevance Framework: BM25 and Beyond*.
