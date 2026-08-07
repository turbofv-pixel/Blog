// Drives an actual browser through Naver Blog's SmartEditor to place a post's text and
// photos/videos exactly where they sit in the source markdown, in one run.
//
// Why this exists: Naver's paste sanitizer only accepts <img>/<video> already hosted on its
// own CDN, and browsers can't hand a foreign page real image/video bytes through the
// clipboard anyway — so nothing client-side can make a plain copy/paste carry brand-new local
// photos into place. The only thing that actually uploads a new file to Naver is Naver's own
// "사진"/"동영상" toolbar button. This script clicks that button for you, at the right spot,
// with the right local file, in the right order — everything else (headings, bold, lists) is
// pasted the same way manual Ctrl+C/Ctrl+V already works.
//
// Usage:
//   node automation/publish-to-naver.mjs posts/parenting/ansan-energy-industrial-history-trip.md
//   node automation/publish-to-naver.mjs <mdFile> <blogId>       # blogId defaults to bigbigrabbit
//   DEBUG=1 node automation/publish-to-naver.mjs <mdFile>        # pause + open inspector on failure
//
// First run opens a real, visible browser window logged into nothing — log into Naver by hand
// in that window. The session is saved under .naver-session/ (gitignored) so later runs skip
// login. The script stops once everything is placed in the editor; it does NOT click 발행, so
// you get a last look before anything goes public.

import { chromium } from 'playwright';
import { marked } from 'marked';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// See the matching comment in src/components/PostManager.tsx: marked's default GFM 'del'
// rule treats a single '~' as a valid strikethrough delimiter, which collides with Korean
// posts' use of '~' as a range dash (e.g. "20~25배 ... 0.90~0.95배"). We never intend
// strikethrough here, so disable the rule instead of escaping every dash by hand.
marked.use({
  tokenizer: {
    del() {
      return undefined;
    },
  },
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SESSION_DIR = path.join(REPO_ROOT, '.naver-session');
const DEBUG = process.env.DEBUG === '1';

const [, , mdArg, blogIdArg] = process.argv;
if (!mdArg) {
  console.error('사용법: node automation/publish-to-naver.mjs <포스트.md 경로> [blogId]');
  process.exit(1);
}
const blogId = blogIdArg || 'bigbigrabbit';
const mdPath = path.isAbsolute(mdArg) ? mdArg : path.join(REPO_ROOT, mdArg);

// ---------------------------------------------------------------------------
// 1. Parse the markdown file into an ordered list of text / image / video blocks
// ---------------------------------------------------------------------------

function parsePost(rawFile) {
  const frontmatterMatch = rawFile.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const frontmatter = {};
  let body = rawFile;
  if (frontmatterMatch) {
    body = rawFile.slice(frontmatterMatch[0].length);
    for (const line of frontmatterMatch[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) frontmatter[m[1]] = m[2].trim().replace(/^"|"$/g, '');
    }
  }
  return { frontmatter, body };
}

const MEDIA_PATTERN = /(!\[[^\]]*\]\([^)]+\)|<video[^>]*src="[^"]*"[^>]*>\s*<\/video>)/g;

function toBlocks(body) {
  return body
    .split(MEDIA_PATTERN)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const imgMatch = chunk.match(/^!\[[^\]]*\]\(([^)]+)\)$/);
      if (imgMatch) return { type: 'image', src: imgMatch[1] };
      const videoMatch = chunk.match(/^<video[^>]*src="([^"]+)"/);
      if (videoMatch) return { type: 'video', src: videoMatch[1] };
      return { type: 'text', markdown: chunk };
    });
}

function localFilePath(src) {
  return path.join(REPO_ROOT, 'public', src.replace(/^\//, ''));
}

function textBlockToHtml(markdownChunk) {
  const html = marked.parse(markdownChunk);
  return `<div style="font-family:'Maru Buri','Nanum Gothic',sans-serif;color:#222222;font-size:16px;line-height:1.8;">${html}</div>`;
}

// ---------------------------------------------------------------------------
// 2. Small helpers for interacting with SmartEditor, with a debug-friendly failure path
// ---------------------------------------------------------------------------

async function withStep(label, fn) {
  process.stdout.write(`\n▶ ${label}...`);
  try {
    const result = await fn();
    console.log(' ✓');
    return result;
  } catch (err) {
    console.log(' ✗');
    console.error(`  실패: ${err.message}`);
    if (DEBUG) {
      console.log('  DEBUG=1 상태라 Playwright Inspector를 엽니다. 직접 진행해보고, 맞는 선택자를 알려주세요.');
      await fn.page?.pause?.();
    }
    throw err;
  }
}

async function pasteHtml(page, frame, html, plainText) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://blog.naver.com' });
  await page.evaluate(async ({ html, plainText }) => {
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([plainText], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
  }, { html, plainText });
  await frame.locator('body').click();
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(400);
}

async function clickToolbarAndUpload(page, buttonSelectors, filePath, timeoutMs) {
  let clicked = false;
  for (const selector of buttonSelectors) {
    const btn = page.locator(selector).first();
    if (await btn.count()) {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        btn.click(),
      ]);
      await chooser.setFiles(filePath);
      clicked = true;
      break;
    }
  }
  if (!clicked) throw new Error(`업로드 버튼을 못 찾았습니다 (시도한 선택자: ${buttonSelectors.join(', ')})`);
  await page.waitForTimeout(timeoutMs);
}

// ---------------------------------------------------------------------------
// 3. Main flow
// ---------------------------------------------------------------------------

async function main() {
  const raw = fs.readFileSync(mdPath, 'utf-8');
  const { frontmatter, body } = parsePost(raw);
  const blocks = toBlocks(body);
  console.log(`포스트: ${frontmatter.title || path.basename(mdPath)}`);
  console.log(`블록 ${blocks.length}개 (텍스트 ${blocks.filter(b => b.type === 'text').length} / 사진 ${blocks.filter(b => b.type === 'image').length} / 동영상 ${blocks.filter(b => b.type === 'video').length})`);

  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = context.pages()[0] || (await context.newPage());

  await page.goto(`https://blog.naver.com/${blogId}?Redirect=Write`, { waitUntil: 'domcontentloaded' });

  console.log('\n로그인이 안 되어 있다면 지금 뜬 브라우저 창에서 직접 로그인해 주세요.');
  console.log('에디터가 열릴 때까지 최대 5분 기다립니다...');

  const editorFrame = await withStep('에디터 로딩 대기', async () => {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      const frame = page.frameLocator('iframe#mainFrame, iframe.se-iframe');
      if (await frame.locator('.se-title-text, [placeholder="제목"]').count()) return frame;
      await page.waitForTimeout(2000);
    }
    throw new Error('에디터를 찾지 못했습니다 (로그인이 안 됐거나 화면 구조가 바뀌었을 수 있어요)');
  });

  await withStep('제목 입력', async () => {
    const title = frontmatter.title || path.basename(mdPath, '.md');
    await editorFrame.locator('.se-title-text, [placeholder="제목"]').first().click();
    await page.keyboard.type(title, { delay: 20 });
  });

  await withStep('본문 영역 포커스', async () => {
    await editorFrame.locator('.se-component-content, .se-text-paragraph').first().click();
  });

  for (const [i, block] of blocks.entries()) {
    const tag = `[${i + 1}/${blocks.length}] ${block.type}`;
    if (block.type === 'text') {
      await withStep(`${tag} 텍스트 붙여넣기`, () =>
        pasteHtml(page, editorFrame, textBlockToHtml(block.markdown), block.markdown));
    } else if (block.type === 'image') {
      await withStep(`${tag} 사진 업로드 (${block.src})`, () =>
        clickToolbarAndUpload(
          page,
          ['.se-toolbar-item-image button', 'button[data-name="image"]', 'button[aria-label="사진"]'],
          localFilePath(block.src),
          2500
        ));
    } else if (block.type === 'video') {
      await withStep(`${tag} 동영상 업로드 (${block.src})`, () =>
        clickToolbarAndUpload(
          page,
          ['.se-toolbar-item-video button', 'button[data-name="video"]', 'button[aria-label="동영상"]'],
          localFilePath(block.src),
          8000
        ));
    }
  }

  console.log('\n모든 블록을 넣었습니다. 브라우저에서 내용을 확인하고 직접 [발행]을 눌러주세요.');
  console.log('이 스크립트는 자동으로 발행하지 않습니다 — 창은 열어둔 채로 두었습니다.');
}

main().catch((err) => {
  console.error('\n중단됨:', err.message);
  process.exitCode = 1;
});