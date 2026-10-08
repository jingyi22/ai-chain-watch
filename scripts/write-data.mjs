// 汇总 fetch-market-data.mjs 的真实数据 + generate-briefing.mjs 的生成文本，
// 写出 data/daily.json（index.html 启动时 fetch 这个文件，失败则回退硬编码数组）。
// 用法：node write-data.mjs <morning|review> <marketData.json> <briefing.json> <outPath> [candidates.json] [signalCandidates.json]
// candidates.json / signalCandidates.json 均可选：分别是 discover-candidates.mjs / discover-industry-signals.mjs 的输出
// （已经过各自脚本内的校验），缺省或读取失败则不更新对应字段（保留上一份数据）。
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const [, , type, marketDataPath, briefingPath, outPath, candidatesPath, signalCandidatesPath] = process.argv;
if (!type || !marketDataPath || !briefingPath || !outPath) {
    console.error('用法: node write-data.mjs <morning|review> <marketData.json> <briefing.json> <outPath> [candidates.json] [signalCandidates.json]');
    process.exit(1);
}

const marketData = JSON.parse(readFileSync(marketDataPath, 'utf8'));
const briefing = JSON.parse(readFileSync(briefingPath, 'utf8'));

function loadJsonIfExists(path) {
    if (!path || !existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

function buildDailyBriefing() {
    if (type === 'morning') {
        return {
            date: marketData.date,
            type: 'morning',
            title: briefing.title,
            overnightMarket: briefing.overnightMarket,
            keyNews: briefing.keyNews || [],
            todayAgenda: briefing.todayAgenda || [],
            goldStockChanges: briefing.goldStockChanges,
            opportunities: [],
            risks: [],
            conclusion: briefing.conclusion
        };
    }
    return {
        date: marketData.date,
        type: 'review',
        title: briefing.title,
        marketOverview: briefing.marketOverview,
        sectorHighlights: briefing.sectorHighlights || [],
        goldStockPerf: briefing.goldStockPerf || [],
        conclusion: briefing.conclusion
    };
}

// 东财涨停池接口(hybk字段)用的是全市场通用行业分类，不筛选的话钢铁/白酒等无关涨停股会混进AI产业链栏目。
// 这里只保留能明确对应到我们4个产业链板块(semiconductor/optical/pcb/storage)的行业标签，严格白名单、宁缺不滥。
// 该接口没有"存储"专属行业标签（存储芯片厂商归在"半导体"大类下），故storage暂无法从hybk单独识别。
const INDUSTRY_SECTOR_MAP = { '半导体': 'semiconductor', '元件': 'pcb', '光学光电子': 'optical', '通信设备': 'optical' };

function buildLimitUpScanData() {
    const items = (marketData.limitUpPool || [])
        .filter(item => INDUSTRY_SECTOR_MAP[item.industry])
        .map(item => ({
            name: item.name,
            code: item.code,
            prefix: item.code && item.code.startsWith('6') ? 'sh' : 'sz',
            sector: INDUSTRY_SECTOR_MAP[item.industry],
            changePct: item.changePct,
            // 该接口不含龙虎榜/北向资金等能判断"真有料/纯炒作"的数据，不编造判断依据；
            // 仅用连板数这一真实字段做保守分类：连板≥2视为real(多日资金持续认可)，首板视为watch(待观察)。
            verdict: item.consecutiveBoards >= 2 ? 'real' : 'watch',
            reason: item.consecutiveBoards > 1 ? `连板${item.consecutiveBoards}板，首次涨停 ${item.firstBoardTime || ''}` : `首次涨停 ${item.firstBoardTime || ''}`
        }));
    return {
        date: marketData.date,
        note: items.length ? '' : '当日暂无AI产业链相关涨停池数据',
        items
    };
}

function buildGoldPoolSignals() {
    const out = {};
    (briefing.goldPoolSignals || []).forEach(s => { out[s.code] = s.signal; });
    return out;
}

function buildPriceData() {
    const out = {};
    Object.values(marketData.quotes || {}).forEach(q => {
        out[q.code] = {
            price: q.price,
            change: q.change,
            changePct: q.changePct,
            high: q.high,
            low: q.low,
            turnover: q.turnover,
            pe: q.pe,
            marketCap: q.marketCap
        };
    });
    return out;
}

const DEFAULT_EXISTING = { dailyBriefings: [], goldPoolSignals: {}, priceData: {}, limitUpScanData: null, aiCandidates: [], candidatesGeneratedAt: null, industrySignalCandidates: [], signalCandidatesGeneratedAt: null };

function loadExisting(path) {
    if (!existsSync(path)) return DEFAULT_EXISTING;
    try {
        return { ...DEFAULT_EXISTING, ...JSON.parse(readFileSync(path, 'utf8')) };
    } catch {
        return DEFAULT_EXISTING;
    }
}

const existing = loadExisting(outPath);
const candidatesResult = loadJsonIfExists(candidatesPath);
const signalCandidatesResult = loadJsonIfExists(signalCandidatesPath);

const newBriefing = buildDailyBriefing();
const dailyBriefings = [newBriefing, ...(existing.dailyBriefings || []).filter(b => b.date !== newBriefing.date)]
    .slice(0, 30);

const output = {
    generatedAt: new Date().toISOString(),
    date: marketData.date,
    dailyBriefings,
    goldPoolSignals: { ...(existing.goldPoolSignals || {}), ...buildGoldPoolSignals() },
    priceData: { ...(existing.priceData || {}), ...buildPriceData() },
    limitUpScanData: buildLimitUpScanData(),
    fetchErrors: marketData.errors || [],
    aiCandidates: candidatesResult ? (candidatesResult.aiCandidates || []) : (existing.aiCandidates || []),
    candidatesGeneratedAt: candidatesResult ? (candidatesResult.candidatesGeneratedAt || null) : (existing.candidatesGeneratedAt || null),
    industrySignalCandidates: signalCandidatesResult ? (signalCandidatesResult.industrySignalCandidates || []) : (existing.industrySignalCandidates || []),
    signalCandidatesGeneratedAt: signalCandidatesResult ? (signalCandidatesResult.signalCandidatesGeneratedAt || null) : (existing.signalCandidatesGeneratedAt || null)
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log('写入完成:', outPath);
