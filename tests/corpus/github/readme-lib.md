tinyqueue
=========

A tiny & fast priority queue. _Zero dependencies._

Install
-------

    npm install tinyqueue

Usage
-----

+ Create a queue with an optional comparator
+ Push items with `push`
+ Pop the smallest with `pop`

Example:

~~~~js
import TinyQueue from 'tinyqueue';

const queue = new TinyQueue([7, 5, 10]);
queue.push(3);
queue.pop(); // 3
~~~~

API
---

1) `push(item)` — adds an item.
2) `pop()` — removes and returns the smallest item.
3) `peek()` — returns the smallest item without removing it.

> **Note**
> The comparator must be consistent.
>
> > Nested quote: inconsistent comparators lead to undefined order.

<!-- TODO: add benchmarks -->

Changelog
---------

* **2.0.0** — rewritten in ES modules
* __1.2.0__ — added `peek`
* 1.0.0 — first release

***

Copyright &copy; 2026 Example. Released under the ISC license.
