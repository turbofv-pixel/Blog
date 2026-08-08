# CLAUDE.md

Guidance for Claude Code (or any future session) working in this repo.

## What this repo is

A personal tool for drafting Naver Blog posts as Markdown, then converting/publishing them
to Naver's SmartEditor. Two things matter for "does my change actually show up":

- **The live site (`https://turbofv-pixel.github.io/Blog/`) renders `samplePosts` in
  `src/App.tsx`**, not the files under `posts/`. Those `.md` files are the source-of-truth
  copies used for git history and the `automation/publish-to-naver.mjs` script — but when
  editing a post's content, the same text has to be updated **in both places** (the `.md`
  file and the matching entry in `src/App.tsx`) or the site and the repo drift apart.
- GitHub Pages only redeploys on push to `master` (or a manual `workflow_dispatch` run of
  `.github/workflows/deploy.yml`) — not on a feature branch or PR.

## Post images: PNG, not SVG

When generating illustrative images/diagrams for a blog post (charts, infographics, step
diagrams, etc.), **always ship them as `.png`**, not `.svg`. If you build the artwork as SVG
first (e.g. for precise vector drawing), render it to PNG before committing and delete the
`.svg` — don't leave both. Reference the `.png` path in the post's Markdown `![]()` syntax.

To convert: render the SVG with Playwright's Chromium at its native `viewBox` size (2x
`deviceScaleFactor` for crispness) and screenshot it — see git history around the
`stock-investing-beginner` and `hanon-systems-stock` image sets for the exact pattern.

## Stock posts: no ticker numbers

Don't include the numeric ticker/종목코드 (e.g. `086520`, `018880`, `247540`) anywhere in a
stock-analysis post — not in the title, headings, body prose, hashtags, or the cover image
artwork. Refer to companies by name only (`에코프로`, `에코프로비엠`, `한온시스템`, ...). This
applies to the `.md` file, the matching `src/App.tsx` entry, and any generated cover image —
tickers have shown up baked into cover-image PNGs before (as rendered text, not just alt
text), so check the image itself, not just the Markdown, when auditing a post.

## Markdown gotcha: single `~` triggers strikethrough

`marked`'s default GFM `del` rule matches **one or more** `~` as a valid strikethrough
delimiter, not just `~~`. Korean posts routinely use a single `~` as a range dash (e.g.
"몇만 원~몇십만 원", "20~25배"). Two such ranges in the same paragraph get read as a
matched open/close pair, silently striking through everything in between.

This is already fixed at the source: both `src/components/PostManager.tsx` and
`automation/publish-to-naver.mjs` call `marked.use({ tokenizer: { del() { return
undefined; } } })` right after importing `marked`, which disables the rule entirely (we
never intentionally use strikethrough). Don't remove that — and don't "fix" future
strikethrough sightings by escaping `~` in post content; fix the tokenizer config instead if
it's ever reverted.
