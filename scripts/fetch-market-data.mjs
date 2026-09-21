// 抓取当日真实行情数据：金股池现价（腾讯行情）+ 涨停池（东财）+ AI产业链相关新闻（东财快讯）
// 输出到 stdout 一份结构化 JSON，供 generate-briefing.mjs 消费。不做任何文本生成/编造，只搬运真实数据。
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 与 index.html 内 goldPool 保持同步的最小字段（code/prefix/name），用于拉取现价。
// 若金股池调仓，需同步更新这里的列表（人工维护，本脚本不负责挑选新标的）。
const GOLD_POOL_CODES = [
    { name: '中船特气', code: '688146', prefix: 'sh' },
    { name: '炬光科技', code: '688167', prefix: 'sh' },
    { name: '长电科技', code: '600584', prefix: 'sh' },
    { name: '江丰电子', code: '300666', prefix: 'sz' },
    { name: '天孚通信', code: '300394', prefix: 'sz' },
    { name: '胜宏科技', code: '300476', prefix: 'sz' },
    { name: '东材科技', code: '601208', prefix: 'sh' },
    { name: '宏和科技', code: '603256', prefix: 'sh' },
    { name: '江波龙', code: '301308', prefix: 'sz' },
    { name: '华海诚科', code: '688535', prefix: 'sh' },
    { name: '鼎龙股份', code: '300054', prefix: 'sz' },
    { name: '中际旭创', code: '300308', prefix: 'sz' }
];

const AI_KW = ['AI','算力','芯片','半导体','光模块','PCB','存储','HBM','MLCC','DRAM','NAND','GPU','英伟达','NVIDIA','WF6','光通信','铜箔','封装','靶材','光刻','SiC','GaN','CPO','NPO','1.6T','800G','EUV','CMP','TGV','ABF','SSD','被动元件','CCL','覆铜板','硅片','晶圆','钼','钨','锡膏','电感'];

function todayYmd() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}
function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function fetchQuotes(stocks) {
    const codes = stocks.map(s => s.prefix + s.code).join(',');
    const res = await fetchWithTimeout(`https://qt.gtimg.cn/q=${codes}`);
    if (!res.ok) throw new Error('qt.gtimg.cn HTTP ' + res.status);
    const buffer = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buffer);
    const out = {};
    text.split('\n').forEach(line => {
        if (!line || !line.includes('="')) return;
        const match = line.match(/="([^"]+)"/);
        if (!match) return;
        const fields = match[1].split('~');
        if (fields.length < 45) return;
        const code = fields[2];
        const stockInfo = stocks.find(s => s.code === code);
        if (!stockInfo) return;
        out[stockInfo.prefix + code] = {
            name: stockInfo.name,
            code,
            price: fields[3] || null,
            prevClose: fields[4] || null,
            change: fields[31] || null,
            changePct: fields[32] || null,
            high: fields[33] || null,
            low: fields[34] || null,
            turnover: fields[38] || null,
            pe: fields[39] || null,
            marketCap: fields[44] || null
        };
    });
    return out;
}

async function fetchLimitUpPool() {
    const date = todayYmd();
    const url = `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=50&sort=fbt:asc&date=${date}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error('push2ex HTTP ' + res.status);
    const json = await res.json();
    const list = (json && json.data && json.data.pool) || [];
    return list.map(item => ({
        code: item.c,
        name: item.n,
        changePct: item.zdp,
        firstBoardTime: item.fbt,
        consecutiveBoards: item.lbc,
        industry: item.hybk
    }));
}

async function fetchAiNews() {
    const url = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_news_col&fastColumn=102&sortEnd=&order=1&pageSize=50&req_trace=1';
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error('np-listapi HTTP ' + res.status);
    const json = await res.json();
    const list = (json && json.data && json.data.fastNewsList) || [];
    return list
        .filter(item => AI_KW.some(kw => (item.title || '').includes(kw)))
        .map(item => ({ title: item.title, time: item.showTime || item.pubTime }));
}

async function main() {
    const result = { date: todayIso(), quotes: {}, limitUpPool: [], news: [], errors: [] };

    try {
        result.quotes = await fetchQuotes(GOLD_POOL_CODES);
    } catch (e) {
        result.errors.push('quotes: ' + e.message);
    }

    try {
        result.limitUpPool = await fetchLimitUpPool();
    } catch (e) {
        result.errors.push('limitUpPool: ' + e.message);
    }

    try {
        result.news = await fetchAiNews();
    } catch (e) {
        result.errors.push('news: ' + e.message);
    }

    process.stdout.write(JSON.stringify(result));
}

main().catch(e => {
    console.error('fetch-market-data fatal:', e);
    process.exit(1);
});
