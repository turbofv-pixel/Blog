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

## Every post opens with the "대왕토끼" greeting

Every post, in every category (육아, 주식, IT, ...) — not just parenting — opens right after
the `# ` H1 with a greeting line like "안녕하세요 대왕토끼입니다~ 🐰" before getting into the
content. Applies to new posts going forward; existing posts don't need to be retrofitted
unless asked.

## Parenting (육아) post titles start with "[아이와 가볼 만한 곳]"

Every 육아-category post's title (both the `.md` frontmatter `title` and the matching
`src/App.tsx` entry) starts with the literal prefix `[아이와 가볼 만한 곳] ` before the rest of
the title, e.g. `[아이와 가볼 만한 곳] 용인시기후변화체험교육센터 후기 (무료 체험관·기후탐험대)`.
The prefix already says "아이와 가볼만한곳", so don't repeat that phrase again later in the same
title (e.g. not `... 아이와 가볼만한곳 후기 ...` — just `... 후기 ...`). Applies to new posts
going forward; existing posts don't need to be retrofitted unless asked.

## Parenting posts end with a short, natural e-book promo CTA

Every new 육아-category post closes with a short, low-key call-to-action promoting the
전자책(e-book) service (source content lives in the separate `turbofv-pixel/E-book` repo,
deployed at `https://e-book-rust-nine.vercel.app/`) — 2~3 sentences, placed after the main
content and before the closing hashtags, not a boxed banner. Tie it naturally to whatever the
post was actually about (e.g. "오늘 같은 하루도 저희 전자책에 좀 더 자세히 담겨있어요" style),
then link to the e-book — the service homepage is the safer link since it always surfaces
"이번 주 전자책"; link straight to a specific book's page (`/<ebook-id>`) instead only when
that book is genuinely what the post's topic connects to. Keep the tone as a gentle mention,
not a hard sell. Applies to new posts going forward; existing 육아 posts don't need to be
retrofitted unless asked.

## Parenting post media: the user processes it themselves now, via MosaicStudio

Earlier posts had Claude do face-detection + bunny-sticker processing directly (Python
scripts in the scratchpad, see the `siheung-breathing-playground` / `yongin-suji-eco-park`
git history). That workflow is retired for new parenting posts. Now:

1. The user uploads raw photos/videos into the in-app **MosaicStudio** tool
   (`src/components/MosaicStudio.tsx`) from their own device — never into this repo.
2. MosaicStudio blurs faces client-side (bunny sticker or pixelate mode) and, on download,
   names the output `rabbit_<original-filename-without-extension>.<ext>` (`.jpg` for photos,
   `.webm`/`.mp4` for videos per `resultExt`) — **the original filename is preserved**, which
   for a phone camera is a timestamp (e.g. `20260808_154453.jpg` → `rabbit_20260808_154453.jpg`).
   That preserved timestamp is the "metadata" Claude should plan around: it's what tells you
   shooting order/time-of-day across a batch without needing to invent descriptive slugs.
3. The user uploads only the already-processed `rabbit_*` files to this repo. When writing a
   post, reference that exact `rabbit_<original-name>.<ext>` filename in the Markdown image
   path — don't rename to a descriptive slug. That way nothing needs renaming on the user's
   end for the post to work once they upload.
4. If raw (unprocessed, un-blurred) originals land in this repo anyway (e.g. an old habit of
   uploading via the bare `/upload` GitHub URL, which drops files at the repo root instead of
   a post's image folder), don't face-process them yourself — that's the user's job now. Just
   flag it and remove the raw files from the repo once their content/timestamps have been
   noted for post-writing purposes; raw un-blurred personal photos shouldn't sit in the repo.

## Post images: PNG, not SVG

When generating illustrative images/diagrams for a blog post (charts, infographics, step
diagrams, etc.), **always ship them as `.png`**, not `.svg`. If you build the artwork as SVG
first (e.g. for precise vector drawing), render it to PNG before committing and delete the
`.svg` — don't leave both. Reference the `.png` path in the post's Markdown `![]()` syntax.

To convert: render the SVG with Playwright's Chromium at its native `viewBox` size (2x
`deviceScaleFactor` for crispness) and screenshot it — see git history around the
`stock-investing-beginner` and `hanon-systems-stock` image sets for the exact pattern.

## Cover images: square-safe, not wide banners

**Naver Blog picks the first image in a post as the mobile list thumbnail, and always crops
it to 1:1 (PC list view crops to 3:2 instead).** A wide banner cover (we used to ship
2400×760, ~3.16:1) survives PC's 3:2 crop fine but loses roughly a third off each side under
mobile's 1:1 crop — which is exactly where a banner layout puts the company name and the
date badge, so the title reads as cut off on phones ("사진이 짤린다").

Build the cover (the *first* image referenced in the post, right after the `# ` H1) as a
**square canvas, 1080×1080 native (2160×2160 at the usual 2x render)**, and keep every
piece of text/data inside a **safe zone of roughly y=190 to y=890** (the middle ~65%). That
band is what survives PC's 3:2 crop from a 1:1 source; the full square already survives
mobile's 1:1 crop with nothing lost. Horizontal placement doesn't need special treatment —
neither crop touches the width. A decorative top accent bar or the small disclaimer line can
sit outside the safe band since losing them costs nothing; the company name, headline, and
stat cards must not.

This only applies to the **cover image** (the thumbnail source). Any other in-body chart or
diagram (price trend, value-chain diagram, etc.) can stay a normal wide/landscape shape —
those never get thumbnail-cropped.

## Stock posts: no ticker numbers

Don't include the numeric ticker/종목코드 (e.g. `086520`, `018880`, `247540`) anywhere in a
stock-analysis post — not in the title, headings, body prose, hashtags, or the cover image
artwork. Refer to companies by name only (`에코프로`, `에코프로비엠`, `한온시스템`, ...). This
applies to the `.md` file, the matching `src/App.tsx` entry, and any generated cover image —
tickers have shown up baked into cover-image PNGs before (as rendered text, not just alt
text), so check the image itself, not just the Markdown, when auditing a post.

## Parenting posts: bunny stickers, not mosaic, over every face

Photos and videos for the 육아(parenting) posts always ship with every visible face covered
by the cute bunny-face sticker (drawn with PIL — see the `make_bunny_sticker()` /
`detect_faces_bgr()` helpers used in git history around the `siheung-breathing-playground`
and `yongin-suji-eco-park` posts), never plain pixelation/mosaic blur. This covers **every**
person visible, not just our own family — other kids, parents, staff caught in the
background all get a sticker too. Detection uses OpenCV's `FaceDetectorYN` (YuNet ONNX
model); tune the score threshold and box-size sanity bounds per scene (a screen full of
animated/cartoon content nearby needs a stricter threshold to avoid false-positive stickers
on the screen itself; a close-up shot needs a looser max-size bound so a real close face
isn't rejected as "too big"). Always QA the result frame-by-frame (contact sheets sampled at
a few fps, not just spot checks) before shipping — a missed frame is a real privacy leak,
and a detector mis-tuned too aggressively floods the frame with false-positive stickers.

Mosaic/pixelation blur (as used in some older posts, e.g. `ansan-energy-industrial-history-trip`)
is being phased out in favor of this sticker treatment — when a post's media gets
re-processed or re-uploaded, redo it as bunny stickers instead of carrying the mosaic
forward.

## Parenting post videos: silent by default

All video attached to a 육아(parenting) post ships **without audible sound** — voices are
personally identifiable and the videos are usually of a public place with other families
around. Don't just strip the audio stream entirely (`-an`), though: Naver's blog video
uploader appears to outright reject a video file that has zero audio streams at all. Instead
mux in a silent audio track (e.g. `ffmpeg -i in.mp4 -f lavfi -i
anullsrc=channel_layout=stereo:sample_rate=44100 -c:v copy -c:a aac -b:a 64k -shortest
out.mp4`) so the file is a structurally normal video+audio mp4 (~-90dB, effectively
inaudible) — see git history around the `siheung-breathing-playground` post for the exact
fix and the failure it was solving.

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

## Markdown gotcha: `**bold**` right before a Korean particle with no space silently fails

`marked`'s emphasis parser can fail to close `**bold**` when the closing `**` is immediately
preceded by `)` and immediately followed by a Korean character with no space, e.g.
`**메타포레스트(메타버스 체험관)**에` renders as literal asterisks instead of `<strong>`.
`**메타포레스트**(메타버스 체험관)에` (move the parenthetical outside the bold) or adding a
space before the particle both render fine. The stray-`**`-in-rendered-HTML regression check
already run before every post commit (render through `marked.parse()`, grep for leftover
`**`) catches this — if it fires, reword the sentence rather than assuming the check is
wrong.
