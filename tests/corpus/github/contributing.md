Contributing
============

Thanks for your interest! Please read this first.

Setup
-----

0. Install Node 22 and Rust stable.
1. Clone the repo:

       git clone https://github.com/z-y-ai/zyrite.git
       cd zyrite

2. Install dependencies:

   ```sh
   pnpm install
   ```

3. Run the app:
   * desktop: `pnpm dev`
   * browser only: `pnpm dev:web`

Commit messages
---------------

+ Use the imperative mood
+ Reference issues like `#123`
+ Keep the first line under 72 characters

Pull requests
-------------

1) Fork and create a branch.
2) Add tests. Fidelity corpus files go in `tests/corpus/`.
3) Make sure `pnpm test` and `cargo test --workspace` pass.

> [!TIP]
> Run `pnpm test -- --watch` while developing.

***

Code of conduct: be kind.
