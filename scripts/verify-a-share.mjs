// 校验某个公司名是否真实在A股（沪A/深A/京A/科创板）上市，用东财证券搜索接口核验，
// 防止LLM把港股/美股公司（如"腾讯"只在港股上市）当成A股候选推出来。
// 查询失败/网络异常时按"未验证"处理（verified:false），即宁可漏掉候选，不可放行未经核实的公司。

const A_SHARE_MARKETS = new Set(['沪A', '深A', '京A', '科创板']);

function normalize(s) {
    return String(s || '').replace(/\s+/g, '').replace(/-[A-Z]+$/, '');
}

function namesMatch(candidateName, shortName) {
    const a = normalize(candidateName);
    const b = normalize(shortName);
    if (!a || !b) return false;
    return a === b || b.startsWith(a) || a.startsWith(b);
}

export async function verifyAShareCompany(name, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const url = `https://search-codetable.eastmoney.com/codetable/search/web?client=web&keyword=${encodeURIComponent(name)}&pageSize=10&pageIndex=1`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const results = (json && json.result) || [];
        const match = results.find(r => A_SHARE_MARKETS.has(r.securityTypeName) && namesMatch(name, r.shortName));
        if (!match) return { verified: false };
        return { verified: true, code: match.code, officialName: match.shortName, market: match.securityTypeName };
    } catch (e) {
        console.error(`verify-a-share: 查询"${name}"失败，按未验证处理:`, e.message);
        return { verified: false };
    } finally {
        clearTimeout(timer);
    }
}
