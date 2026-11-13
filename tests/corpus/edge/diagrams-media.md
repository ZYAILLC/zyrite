# Diagrams, data tables and media

A Graphviz graph:

```dot
digraph G {
  rankdir=LR;
  node [shape=box];
  draft -> review -> "ship it" [label="ok"];
  review -> draft [style=dashed];
}
```

The same with the `graphviz` language name:

```graphviz
graph { a -- b -- c; a -- c }
```

A mind map:

```markmap
# Zyrite
## Editing
- WYSIWYG
- Source
## Review
- Agents
- Annotations
```

CSV with quoted fields, an embedded newline and an escaped quote:

```csv
name,role,note
"Smith, Jane",editor,"says ""hi"""
Li Lei,writer,"line one
line two"
short row
```

TSV:

```tsv
id	title	done
1	Draft	yes
2	Review	no
```

Media through image syntax: ![Demo clip](media/demo.mp4) and ![Theme song](media/theme.mp3).

A remote video stays a link: ![Remote](https://example.com/video.webm)

Obsidian embeds:

![[a.mp4]]

![[song.mp3|Theme]]

![[clip.mov|320]]
