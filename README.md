# markdown-render-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/RSfer95/markdown-render-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/RSfer95/markdown-render-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast Markdown renderer, byte-identical to marked 18.1.3.

A single-pass, dependency-free parser written from scratch in plain JavaScript. It renders CommonMark plus GitHub Flavored Markdown exactly the way marked does, only faster: no regex in the hot paths, no token AST, HTML emitted directly while scanning.

## Run it

```sh
node main.ts
```

`main.ts` reads `cases.json` from the input directory and writes the rendered HTML array to the output directory.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jdzfzmr8&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
