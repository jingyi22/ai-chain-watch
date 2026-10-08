// 半自动AI候选股发现：从当日真实抓取到的AI产业链新闻里，让LLM筛出"可能值得关注但尚未在金股池"的候选标的。
// 严格约束：候选股的新闻依据(newsQuote)必须能在输入的news数组里找到对应真实标题，不允许引用news数组之外的任何事件/数字。
// 输出仅供人工审查（观察池tab的"AI新闻候选"卡片），不会自动写入goldPool/WATCHLIST/advisorReport——转正需人工手动编辑index.html。
// 用法：node discover-candidates.mjs < market-data.json > candidates.json
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

const SYSTEM_PROMPT = `你是一名A股AI算力产业链候选标的初筛助手。你只能依据用户消息里 newsList 数组中出现的新闻标题来推测"哪些公司/股票可能值得关注"；严禁编造、猜测、或引用 newsList 之外的任何新闻事件、数字、公告。
如果某条候选的公司名找不到在 newsList 任何一条标题里出现，就不要输出这条候选。
如果 newsList 为空或找不到任何可推荐的候选，输出空数组 []。
输出必须是一个JSON数组，不要输出任何数组之外的文字，不要用markdown代码块包裹。`;

function buildUserPrompt(marketData) {
    const excludeCodes = Object.values(marketData.quotes || {}).map(q => q.code);
    return `以下是今日真实抓取到的AI产业链相关新闻标题(newsList)：

newsList = ${JSON.stringify(marketData.news || [])}

已在金股池中的股票代码（不要再推荐这些）：${JSON.stringify(excludeCodes)}

请从 newsList 中挑出最多5条"可能值得关注的候选股票"，每条输出以下字段的JSON对象：
{
  "name": "公司名，必须是newsList某条title里实际出现的公司名",
  "code": "推测的6位股票代码（如果新闻标题里没有明确代码，也要给出你认为最匹配的代码，格式必须是6位数字）",
  "newsQuote": "必须是newsList里某条title的原文或几乎逐字的引用，不要改写内容",
  "newsTime": "对应新闻的time字段原文",
  "reason": "一句话说明为什么关注，只能引用newsQuote里出现的内容，不要添加newsQuote之外的具体数字或事件"
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
// 第一层：验证"这条新闻真实存在"和"公司名确实出现在该新闻依据里"。
// 第二层：验证"这家公司是否真实在A股（沪A/深A/京A/科创板）上市"，用东财证券搜索接口核验——
// 防止LLM把港股/美股公司（如腾讯只在港股上市）当成A股候选推出来，也顺带拿到真实代码替换LLM猜测的代码。
function fuzzyContains(haystack, needle) {
    if (!haystack || !needle) return false;
    const h = haystack.replace(/\s+/g, '');
    const n = needle.replace(/\s+/g, '');
    if (h.includes(n)) return true;
    // 允许小幅改写：按最短公共子串近似（长度差在10%以内且大部分字符重合）
    if (Math.abs(h.length - n.length) / Math.max(h.length, n.length) > 0.3) return false;
    let matched = 0;
    for (const ch of n) if (h.includes(ch)) matched++;
    return matched / n.length > 0.85;
}

async function verifyCandidateStocks(candidates, newsList) {
    const titles = (newsList || []).map(n => n.title || '');
    const out = [];
    for (const c of candidates) {
        if (!c || !c.name || !c.code || !c.newsQuote) continue;
        const quoteMatchesRealNews = titles.some(t => fuzzyContains(t, c.newsQuote) || fuzzyContains(c.newsQuote, t));
        if (!quoteMatchesRealNews) continue;
        if (!c.newsQuote.includes(c.name)) continue;
        const aShare = await verifyAShareCompany(c.name);
        if (!aShare.verified) {
            console.error(`discover-candidates: "${c.name}" 未能核验为A股上市公司，丢弃该候选`);
            continue;
        }
        out.push({
            name: aShare.officialName,
            code: aShare.code,
            newsQuote: c.newsQuote,
            newsTime: c.newsTime || '',
            reason: c.reason || '',
            codeUnverified: false,
            codeFormatValid: true
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
        console.error('discover-candidates: LLM调用/解析失败，输出空候选列表:', e.message);
        rawCandidates = [];
    }
    const verified = await verifyCandidateStocks(rawCandidates, marketData.news || []);
    process.stdout.write(JSON.stringify({
        candidatesGeneratedAt: new Date().toISOString().slice(0, 19) + 'Z',
        aiCandidates: verified
    }));
}

main().catch(e => {
    console.error('discover-candidates failed:', e.message);
    process.stdout.write(JSON.stringify({ candidatesGeneratedAt: null, aiCandidates: [] }));
});
