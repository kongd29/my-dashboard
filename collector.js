// collector.js (CommonJS)
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

const puppeteer = require("puppeteer");
const puppeteerExtra = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteerExtra.use(StealthPlugin());

// ===== 사용자 키워드(필요하면 수정) =====
const KEYWORDS = [
  "공모", "지원", "모집", "사업", "바우처", "창업", "소상공인", "전통시장", "상권",
  "판로", "마케팅", "컨설팅", "교육", "자금", "융자", "보조", "지원사업"
];

// ===== 수집 사이트 (동적 사이트는 브라우저 모드 강제 적용) =====
const SOURCES = [
  { id: "mss_incheon",  name: "인천중소벤처기업청",       url: "https://www.mss.go.kr/site/incheon/ex/bbs/List.do?cbIdx=248", mode: "auto" },
  { id: "kosmes",       name: "중소벤처기업진흥공단",     url: "https://www.kosmes.or.kr/nsh/nt/bbs/getBbsList.do?bbsCategory=01", mode: "auto" },
  { id: "smr",          name: "성남상권재단",             url: "https://www.smr.or.kr/base/board/list?boardManagementNo=1", mode: "auto" },
  { id: "gmr",          name: "경기도상권진흥원",         url: "https://www.gmr.or.kr/base/board/list?boardManagementNo=1", mode: "auto" },
  { id: "bizok",        name: "비즈오케이(인천)",         url: "https://bizok.incheon.go.kr/open_content/biz.do", mode: "browser" }, // 보안/동적 강제
  { id: "wbiz",         name: "여성기업종합정보포털",     url: "https://www.wbiz.or.kr/notice/biz.do", mode: "auto" },
  { id: "semas",        name: "소상공인시장진흥공단",     url: "https://www.semas.or.kr/web/board/webBoardList.do?boardId=30", mode: "auto" },
  { id: "insupport",    name: "인천소상공인지원센터",     url: "https://www.insupport.or.kr/sub/sub03_02.php", mode: "auto" },
  { id: "nhn_commerce", name: "NHN커머스",               url: "https://www.nhn-commerce.com/support/notice-list.gd", mode: "auto" },
  { id: "gobiz",        name: "고비즈",                   url: "https://kr.gobizkorea.com/customer/notice/noticeList.do", mode: "auto" },
  { id: "fanfandaero",  name: "판판대로",                 url: "https://fanfandaero.kr/portal/read/readDetail.do", mode: "browser" }, // Vue.js 등 동적 렌더링 강제
  { id: "sbiz24",       name: "소상공인24",               url: "https://www.sbiz24.kr/#/combinePblanc", mode: "browser" }, // Hash SPA 라우팅 강제
  { id: "kodma",        name: "한국소상공인기업총연합회", url: "https://www.kodma.or.kr/bbs/list.do?&bbs_cd=notice", mode: "auto" },
  { id: "ymf_notice",   name: "전통시장육성재단(공지)",   url: "https://www.ymf.or.kr/sub/sub03_03.php", mode: "auto" },
  { id: "ymf_related",  name: "전통시장육성재단(유관)",   url: "https://www.ymf.or.kr/sub/sub03_05.php", mode: "auto" },
];

const MAX_ITEMS_PER_SOURCE = 30;
const SITE_WATCHDOG_MS = 60_000;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function normalizeForScan(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function saveEvidence(id, reason, content) {
  const dir = path.join(process.cwd(), "evidence");
  ensureDir(dir);
  const file = path.join(dir, `${id}_${reason}_${ts()}.html`);
  fs.writeFileSync(file, content || "", "utf-8");
  return file;
}

async function withWatchdog(promise, ms, label) {
  let t;
  const timeoutPromise = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`watchdog_timeout:${label}:${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(t);
  }
}

function detectGate(html) {
  const h = normalizeForScan(html).toLowerCase();
  const waf = h.includes("/cdn-cgi/") || h.includes("cf-ray") || h.includes("cloudflare");
  if (waf) return { gated: true, reason: "waf_cloudflare" };
  const captchaReal = h.includes("자동입력방지") || h.includes("보안문자") || h.includes("g-recaptcha") || h.includes('id="captcha"');
  const onlyLib = h.includes("kcaptcha") && !captchaReal;
  if (!onlyLib && captchaReal) return { gated: true, reason: "captcha" };
  return { gated: false, reason: null };
}

function normalizeUrl(baseUrl, href) {
  try { return new URL(href, baseUrl).toString(); } catch { return href; }
}

function guessDate(text) {
  const m = (text || "").match(/(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

function keywordScore(title) {
  if (!title) return 0;
  let s = 0;
  for (const k of KEYWORDS) if (title.includes(k)) s++;
  return s;
}

async function fetchHtmlAxios(url) {
  const r = await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
      "Upgrade-Insecure-Requests": "1"
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
    items.push({
      source_id: source.id,
      source_name: source.name,
      title,
      url: normalizeUrl(source.url, href),
      notice_date: guessDate(ctxText) || guessDate(title),
      collected_at: new Date().toISOString(),
    });
  };

  $("tr, li, .board-list-item").each((_, el) => {
    const rowText = $(el).text().replace(/\s+/g, " ").trim();
    const a = $(el).find("a").first();
    pushItem(a.text(), a.attr("href"), rowText);
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

// 명시적 요소 대기 및 스크롤 동작이 추가된 브라우저 로직
async function fetchByBrowser(browser, source) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  page.setDefaultNavigationTimeout(35000);

  try {
    await page.goto(source.url, { waitUntil: "networkidle2" });
    
    // 지연 로딩 방지용 스크롤
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await sleep(1000);
    
    // 중요: 게시판 항목(a 태그나 tr 태그)이 화면에 뜰 때까지 최대 5초간 대기
    await page.waitForSelector('tbody tr, ul li a, .board-list a', { timeout: 5000 }).catch(() => {});
  } catch {
    try {
      const client = await page.target().createCDPSession();
      await client.send("Page.stopLoading");
    } catch {}
  }

  await sleep(3000); // 렌더링 완료 후 혹시 모를 추가 데이터를 위한 여유 대기
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
        result.status = "gated";
        result.reason = gate.reason;
        result.used = "axios";
        result.evidence_file = saveEvidence(source.id, gate.reason, html);
        return result;
      }
      const items = extractItemsFromHtml(html, source);
      if (items.length > 0) {
        result.status = "success";
        result.items = items;
        result.count = items.length;
        result.used = "axios";
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
        result.status = "gated";
        result.reason = gate.reason;
        result.used = "puppeteer";
        result.evidence_file = saveEvidence(source.id, gate.reason, html);
        return result;
      }

      const items = extractItemsFromHtml(html, source);
      result.items = items;
      result.count = items.length;
      result.status = result.count > 0 ? "success" : "zero";
      result.used = "puppeteer";

      if (result.status === "zero") {
        result.evidence_file = saveEvidence(source.id, "zero_items", html);
      }
      return result;
    } catch (e) {
      result.status = "fail";
      result.reason = "network_or_timeout";
      result.used = "puppeteer_fail";
      result.evidence_file = saveEvidence(source.id, "network_or_timeout", `ERROR: ${String(e)}`);
      return result;
    }
  }

  result.status = "fail";
  result.reason = "network_or_timeout";
  result.evidence_file = saveEvidence(source.id, "network_or_timeout", "ERROR: no_available_method");
  return result;
}

(async () => {
  console.log("[수집 시작] axios → (실패/0건) → puppeteer 폴백 + 워치독");
  ensureDir(path.join(process.cwd(), "evidence"));

  const browser = await puppeteerExtra.launch({
    headless: "new",
    args: [
      "--no-sandbox", 
      "--disable-setuid-sandbox", 
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
      "--ignore-certificate-errors" // HTTPS 인증서 오류 무시 추가
    ],
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
      r = {
        status: "fail",
        reason: msg.startsWith("watchdog_timeout") ? "watchdog_timeout" : "network_or_timeout",
        count: 0,
        used: "watchdog",
        evidence_file: saveEvidence(s.id, "watchdog_timeout", `ERROR: ${msg}`),
        items: [],
      };
    }

    status[s.id] = { name: s.name, url: s.url, status: r.status, reason: r.reason, count: r.count, used: r.used, evidence_file: r.evidence_file };

    if (r.status === "success") {
      console.log(`OK (${r.count}) [${r.used}]`);
      allItems.push(...(r.items || []));
    } else if (r.status === "zero") {
      console.log(`0건 [${r.used}]`);
    } else if (r.status === "gated") {
      console.log(`차단(${r.reason}) [${r.used}]`);
    } else {
      console.log(`실패(${r.reason}) [${r.used}]`);
    }
    await sleep(1500);
  }

  await browser.close();

  fs.writeFileSync(
    "feed.json",
    JSON.stringify({ generated_at: new Date().toISOString(), keywords: KEYWORDS, items: allItems, status }, null, 2),
    "utf-8"
  );
  console.log("\n완료: feed.json 생성됨 / evidence 폴더에 증거 저장됨");
})();