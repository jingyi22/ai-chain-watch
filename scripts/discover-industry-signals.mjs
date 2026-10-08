// 半自动产业信号发现：从当日真实抓取到的AI产业链新闻里，让LLM筛出"可能构成产业信号"的候选条目
// （涨价/断供/招标/产能/政策/业绩等），仅供人工审查后手动写入 industrySignals 静态数组，不自动转正。
// 严格约束：候选的新闻依据(newsQuote)必须能在输入的news数组里找到对应真实标题，不允许引用news数组之外的任何事件/数字。
// 用法：node discover-industry-signals.mjs < market-data.json > signal-candidates.json
// OPENROUTER_API_KEY 必须通过环境变量传入，脚本本身不读取/不写入任何密钥到文件。

import { verifyAShareCompany } from './verify-a-share.mjs';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
    console.error('缺少环境变量 OPENROUTER_API_KEY');
    process.exit(1);
}

function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

const SIGNAL_TYPES = ['涨价', '断供', '招标', '现货价', '产能', '政策', '中标', '业绩', '事故', '增持', '减持', '研报'];
const SECTOR_KEYS = ['semiconductor', 'optical', 'pcb', 'storage'];

const SYSTEM_PROMPT = `你是一名A股AI算力产业链产业信号初筛助手。你只能依据用户消息里 newsList 数组中出现的新闻标题推测"这是否构成一条产业信号(涨价/断供/招标/产能/政策/业绩等)"；严禁编造、猜测、或引用 newsList 之外的任何新闻事件、具体数字、公告内容。
如果某条候选在 newsList 任何一条标题里找不到对应依据，就不要输出这条候选。
如果 newsList 为空或找不到任何可判断的信号，输出空数组 []。
输出必须是一个JSON数组，不要输出任何数组之外的文字，不要用markdown代码块包裹。`;

function buildUserPrompt(marketData) {
    return `以下是今日真实抓取到的AI产业链相关新闻标题(newsList)：

newsList = ${JSON.stringify(marketData.news || [])}

请从 newsList 中挑出最多5条"可能构成产业信号"的新闻，每条输出以下字段的JSON对象：
{
  "signalType": "必须是以下之一：${JSON.stringify(SIGNAL_TYPES)}",
  "sector": "必须是以下之一：${JSON.stringify(SECTOR_KEYS)}（semiconductor=半导体，optical=光通信，pcb=PCB，storage=存储）",
  "newsQuote": "必须是newsList里某条title的原文或几乎逐字的引用，不要改写内容",
  "newsTime": "对应新闻的time字段原文",
  "impact": "利好/利空/中性 三者之一，只依据newsQuote本身的措辞判断，不要引入newsQuote之外的推测",
  "stocks": ["仅当newsQuote原文中明确出现的公司名才列入，没有就给空数组"],
  "reason": "一句话说明这条信号的要点，只能引用newsQuote里出现的内容，不要添加newsQuote之外的具体数字或事件"
}

直接输出JSON数组，不要包裹在markdown代码块里，不要添加任何解释性文字。`;
}

async function callOpenRouter(marketData) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'deepseek/deepseek-chat',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: buildUserPrompt(marketData) }
            ],
            temperature: 0.3
        })
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = await res.json();
    const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!content) throw new Error('OpenRouter 返回内容为空');
    const cleaned = content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error('OpenRouter 输出不是JSON数组');
    return parsed;
}

// 逐条校验候选，不通过的直接丢弃（不影响其他候选）。
// 第一层：验证"这条新闻真实存在"和"信号分类/板块在允许范围内"。
// 第二层：stocks数组逐个用东财证券搜索接口核验是否真实在A股上市——防止把港股/美股公司
// （如新闻里提到的"腾讯"）当成A股关联标的带出来；未能核验的名字直接从stocks里剔除。
function fuzzyContains(haystack, needle) {
    if (!haystack || !needle) return false;
    const h = haystack.replace(/\s+/g, '');
    const n = needle.replace(/\s+/g, '');
    if (h.includes(n)) return true;
    if (Math.abs(h.length - n.length) / Math.max(h.length, n.length) > 0.3) return false;
    let matched = 0;
    for (const ch of n) if (h.includes(ch)) matched++;
    return matched / n.length > 0.85;
}

async function verifySignalCandidates(candidates, newsList) {
    const titles = (newsList || []).map(n => n.title || '');
    const out = [];
    for (const c of candidates) {
        if (!c || !c.newsQuote) continue;
        const quoteMatchesRealNews = titles.some(t => fuzzyContains(t, c.newsQuote) || fuzzyContains(c.newsQuote, t));
        if (!quoteMatchesRealNews) continue;
        if (!SIGNAL_TYPES.includes(c.signalType)) continue;
        if (!SECTOR_KEYS.includes(c.sector)) continue;
        const impact = ['利好', '利空', '中性'].includes(c.impact) ? c.impact : '中性';
        const rawStocks = Array.isArray(c.stocks) ? c.stocks.filter(s => typeof s === 'string' && c.newsQuote.includes(s)) : [];
        const stocks = [];
        for (const name of rawStocks) {
            const aShare = await verifyAShareCompany(name);
            if (aShare.verified) {
                stocks.push(aShare.officialName);
            } else {
                console.error(`discover-industry-signals: "${name}" 未能核验为A股上市公司，从stocks中剔除`);
            }
        }
        out.push({
            signalType: c.signalType,
            sector: c.sector,
            newsQuote: c.newsQuote,
            newsTime: c.newsTime || '',
            impact,
            stocks,
            reason: c.reason || ''
        });
    }
    return out;
}

async function main() {
    const raw = await readStdin();
    const marketData = JSON.parse(raw);
    let rawCandidates = [];
    try {
        rawCandidates = await callOpenRouter(marketData);
    } catch (e) {
        console.error('discover-industry-signals: LLM调用/解析失败，输出空候选列表:', e.message);
        rawCandidates = [];
    }
    const verified = await verifySignalCandidates(rawCandidates, marketData.news || []);
    process.stdout.write(JSON.stringify({
        signalCandidatesGeneratedAt: new Date().toISOString().slice(0, 19) + 'Z',
        industrySignalCandidates: verified
    }));
}

main().catch(e => {
    console.error('discover-industry-signals failed:', e.message);
    process.stdout.write(JSON.stringify({ signalCandidatesGeneratedAt: null, industrySignalCandidates: [] }));
});
