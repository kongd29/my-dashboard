// collector.js (CommonJS)
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

const puppeteer = require("puppeteer");
const puppeteerExtra = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteerExtra.use(StealthPlugin());

const KEYWORDS = [
  "공모", "지원", "모집", "사업", "바우처", "창업", "소상공인", "전통시장", "상권",
  "판로", "마케팅", "컨설팅", "교육", "자금", "융자", "보조", "지원사업"
];

const SOURCES = [
  { id: "mss_incheon",  name: "인천중소벤처기업청",       url: "https://www.mss.go.kr/site/incheon/ex/bbs/List.do?cbIdx=246", mode: "auto" },
  { id: "kosmes",       name: "중소벤처기업진흥공단",     url: "https://www.kosmes.or.kr/nsh/nt/bbs/getBbsList.do?bbsId=114", mode: "auto" },
  { id: "smr",          name: "성남산업진흥원",           url: "https://www.snip.or.kr/portal/snip/MainMenu/businessManagement/application.page", mode: "browser" },
  { id: "gmr",          name: "경기도시장상권진흥원",     url: "https://www.gmr.or.kr/gmr/board/1/board.do", mode: "auto" },
  { id: "bizok",        name: "비즈오케이(인천)",         url: "https://bizok.incheon.go.kr/open_content/support/application.jsp", mode: "browser" },
  { id: "wbiz",         name: "여성기업종합정보포털",     url: "https://www.wbiz.or.kr/web/board/boardList.do?boardId=10", mode: "auto" },
  { id: "semas",        name: "소상공인시장진흥공단",     url: "https://www.semas.or.kr/web/board/webBoardList.do?boardId=30", mode: "browser" },
  { id: "insupport",    name: "인천소상공인지원센터",     url: "https://www.insupport.or.kr/sub/sub03_02.php", mode: "auto" },
  { id: "nhn_commerce", name: "NHN커머스",               url: "https://www.nhn-commerce.com/customer-center/notice", mode: "browser" },
  { id: "gobiz",        name: "고비즈",                   url: "https://kr.gobizkorea.com/customer/notice/noticeList.do", mode: "browser" },
  { id: "fanfandaero",  name: "판판대로",                 url: "https://fanfandaero.kr/portal/brd/boardList.do?brdId=1", mode: "browser" },
  { id: "sbiz24",       name: "소상공인24",               url: "https://www.sbiz24.kr/#/combinePblanc", mode: "browser" },
  { id: "kodma",        name: "한국소상공인기업총연합회", url: "https://www.kodma.or.kr/bbs/list.do?&bbs_cd=notice", mode: "auto" },
  { id: "ymf_notice",   name: "전통시장육성재단(공지)",   url: "https://www.ymf.or.kr/sub/sub03_03.php", mode: "auto" },
  { id: "ymf_related",  name: "전통시장육성재단(유관)",   url: "https://www.ymf.or.kr/sub/sub03_05.php", mode: "auto" },
];

const MAX_ITEMS_PER_SOURCE = 30;
const SITE_WATCHDOG_MS = 60_000;

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function ts() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function normalizeForScan(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function saveEvidence(id, reason, content) {
  const dir = path.join(process.cwd(), "evidence"); ensureDir(dir);
  const file = path.join(dir, `${id}_${reason}_${ts()}.html`);
  fs.writeFileSync(file, content || "", "utf-8"); return file;
}

async function withWatchdog(promise, ms, label) {
  let t;
  const timeoutPromise = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`watchdog_timeout:${label}:${ms}ms`)), ms); });
  try { return await Promise.race([promise, timeoutPromise]); } finally { clearTimeout(t); }
}

function detectGate(html) {
  const h = normalizeForScan(html).toLowerCase();
  if (h.includes("/cdn-cgi/") || h.includes("cloudflare")) return { gated: true, reason: "waf_cloudflare" };
  if (h.includes("자동입력방지") || h.includes("g-recaptcha")) return { gated: true, reason: "captcha" };
  return { gated: false, reason: null };
}

// 🚀 [수정 포인트 1] URL 정규화 시 about:blank 방지 로직 추가
function normalizeUrl(baseUrl, href) {
  if (!href) return baseUrl;
  // 자바스크립트 링크나 앵커 태그인 경우 오류 방지를 위해 원본 게시판 주소 반환
  if (href === "#" || href.toLowerCase().includes("javascript")) {
    return baseUrl; 
  }
  try { return new URL(href, baseUrl).toString(); } catch { return baseUrl; }
}

function guessDate(text) {
  const m = (text || "").match(/(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

function keywordScore(title) {
  if (!title) return 0;
  let s = 0; for (const k of KEYWORDS) if (title.includes(k)) s++; return s;
}

async function fetchHtmlAxios(url) {
  const r = await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8"
    },
  });
  return String(r.data || "");
}

function extractItemsFromHtml(html, source) {
  const $ = cheerio.load(html);
  const items = [];

  const pushItem = (title, href, ctxText) => {
    title = (title || "").replace(/\s+/g, " ").trim();
    if (!title || title.length < 4 || !href) return;
    
    // 🚀 [수정 포인트 2] 추출 시 자바스크립트 링크를 바로 원본 주소로 교체
    if (href === "#" || href.toLowerCase().includes("javascript")) {
      href = source.url; 
    }

    items.push({
      source_id: source.id,
      source_name: source.name,
      title,
      url: normalizeUrl(source.url, href),
      notice_date: guessDate(ctxText) || guessDate(title),
      collected_at: new Date().toISOString(),
    });
  };

  // 🚀 [수정 포인트 3] 공공기관에서 자주 쓰는 숨겨진 태그들 추가 탐색
  $("tr, li, .board-list-item, .item-list, .tbl_list tbody tr, .board_list tbody tr, .el-table__row").each((_, el) => {
    const rowText = $(el).text().replace(/\s+/g, " ").trim();
    const a = $(el).find("a").first();
    const onclick = a.attr("onclick");
    let href = a.attr("href");

    // href가 비어있고 onclick만 있는 경우
    if (!href && onclick) href = source.url;

    pushItem(a.text(), href, rowText);
  });

  const uniq = new Map();
  for (const it of items) {
    const key = `${it.title}::${it.url}`;
    if (!uniq.has(key)) uniq.set(key, it);
  }
  const arr = Array.from(uniq.values());
  const withKw = arr.filter((x) => keywordScore(x.title) > 0);
  const base = withKw.length > 0 ? withKw : arr;
  base.sort((a, b) => keywordScore(b.title) - keywordScore(a.title));
  return base.slice(0, MAX_ITEMS_PER_SOURCE);
}

async function fetchByBrowser(browser, source) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  page.setDefaultNavigationTimeout(35000);

  try {
    await page.goto(source.url, { waitUntil: "networkidle2" });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await sleep(2500); // 렌더링 시간 확보
  } catch {
    try {
      const client = await page.target().createCDPSession();
      await client.send("Page.stopLoading");
    } catch {}
  }

  await sleep(3000); 
  const html = await page.content();
  await page.close();
  return html;
}

async function collectOne(source, browser) {
  const result = { status: "unknown", reason: null, evidence_file: null, count: 0, items: [], used: null };
  const tryAxios = source.mode === "axios" || source.mode === "auto";
  const tryBrowser = source.mode === "browser" || source.mode === "auto";

  if (tryAxios) {
    try {
      const html = await fetchHtmlAxios(source.url);
      const gate = detectGate(html);
      if (gate.gated) {
        result.status = "gated"; result.reason = gate.reason; result.used = "axios";
        return result;
      }
      const items = extractItemsFromHtml(html, source);
      if (items.length > 0) {
        result.status = "success"; result.items = items; result.count = items.length; result.used = "axios";
        return result;
      }
      result.used = "axios_zero";
    } catch {
      result.used = "axios_fail";
    }
  }

  if (tryBrowser && browser) {
    try {
      const html = await fetchByBrowser(browser, source);
      const gate = detectGate(html);
      if (gate.gated) {
        result.status = "gated"; result.reason = gate.reason; result.used = "puppeteer";
        return result;
      }

      const items = extractItemsFromHtml(html, source);
      result.items = items; result.count = items.length;
      result.status = result.count > 0 ? "success" : "zero"; result.used = "puppeteer";
      return result;
    } catch (e) {
      result.status = "fail"; result.reason = "network_or_timeout"; result.used = "puppeteer_fail";
      return result;
    }
  }

  result.status = "fail"; result.reason = "network_or_timeout";
  return result;
}

(async () => {
  console.log("[수집 시작] 하얀 화면 방지 및 탐색 로직 강화 버전...");
  ensureDir(path.join(process.cwd(), "evidence"));

  const browser = await puppeteerExtra.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--window-size=1920,1080", "--ignore-certificate-errors"],
  });

  const allItems = [];
  const status = {};

  for (const s of SOURCES) {
    process.stdout.write(`- ${s.name} ... `);
    let r;
    try {
      r = await withWatchdog(collectOne(s, browser), SITE_WATCHDOG_MS, s.id);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      r = { status: "fail", reason: msg.startsWith("watchdog_timeout") ? "watchdog_timeout" : "network_or_timeout", count: 0, used: "watchdog", items: [] };
    }

    status[s.id] = { name: s.name, url: s.url, status: r.status, reason: r.reason, count: r.count, used: r.used, evidence_file: r.evidence_file };

    if (r.status === "success") {
      console.log(`OK (${r.count}) [${r.used}]`);
      allItems.push(...(r.items || []));
    } else if (r.status === "zero") {
      console.log(`0건 [${r.used}]`);
    } else {
      console.log(`실패/차단(${r.reason}) [${r.used}]`);
    }
    await sleep(1500);
  }

  await browser.close();

  fs.writeFileSync("feed.json", JSON.stringify({ generated_at: new Date().toISOString(), keywords: KEYWORDS, items: allItems, status }, null, 2), "utf-8");
  console.log("\n완료: feed.json 생성됨");
})();