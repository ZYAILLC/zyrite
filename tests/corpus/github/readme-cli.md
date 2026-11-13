<p align="center">
  <img src="docs/logo.svg" width="120" alt="logo">
</p>

<h1 align="center">fastgrep</h1>

<p align="center">
  <a href="https://github.com/example/fastgrep/actions"><img src="https://img.shields.io/github/actions/workflow/status/example/fastgrep/ci.yml" alt="CI"></a>
  <a href="https://crates.io/crates/fastgrep"><img src="https://img.shields.io/crates/v/fastgrep" alt="crates.io"></a>
</p>

A line-oriented search tool that recursively searches directories for a regex pattern. Inspired by [ripgrep][rg] and [The Silver Searcher](https://github.com/ggreer/the_silver_searcher).

[![Downloads](https://img.shields.io/crates/d/fastgrep.svg)](https://crates.io/crates/fastgrep)

## Installation

| Platform | Command |
| :------- | :------ |
| macOS    | `brew install fastgrep` |
| Windows  | `winget install fastgrep` |
| Arch     | `pacman -S fastgrep` |

Or build from source:

```sh
git clone https://github.com/example/fastgrep
cd fastgrep && cargo build --release
```

## Usage

```console
$ fastgrep -i "todo" src/
src/main.rs:12:    // TODO: handle errors
```

<details>
<summary>All options</summary>

```
-i, --ignore-case    Case insensitive search
-w, --word-regexp    Only match whole words
```

</details>

## Benchmarks

Searching the Linux kernel source (`~70k` files) on an M2:

| Tool | Time | Speedup |
|------|-----:|:-------:|
| grep | 4.21s | 1.0x |
| fastgrep | 0.38s | 11.1x |

See https://example.com/bench for methodology[^1].

## License

Dual-licensed under MIT or Apache-2.0, at your option. See <https://example.com/license>.

[^1]: Numbers are the median of 10 runs with a warm cache.

[rg]: https://github.com/BurntSushi/ripgrep
