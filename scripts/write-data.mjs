// 汇总 fetch-market-data.mjs 的真实数据 + generate-briefing.mjs 的生成文本，
// 写出 data/daily.json（index.html 启动时 fetch 这个文件，失败则回退硬编码数组）。
// 用法：node write-data.mjs <morning|review> <marketData.json> <briefing.json> <outPath>
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const [, , type, marketDataPath, briefingPath, outPath] = process.argv;
if (!type || !marketDataPath || !briefingPath || !outPath) {
    console.error('用法: node write-data.mjs <morning|review> <marketData.json> <briefing.json> <outPath>');
    process.exit(1);
}

const marketData = JSON.parse(readFileSync(marketDataPath, 'utf8'));
const briefing = JSON.parse(readFileSync(briefingPath, 'utf8'));

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

function buildLimitUpScanData() {
    const items = (marketData.limitUpPool || []).map(item => ({
        name: item.name,
        code: item.code,
        prefix: item.code && item.code.startsWith('6') ? 'sh' : 'sz',
        sector: item.industry || '',
        changePct: item.changePct,
        verdict: '',
        reason: item.consecutiveBoards > 1 ? `连板${item.consecutiveBoards}板，首次涨停 ${item.firstBoardTime || ''}` : `首次涨停 ${item.firstBoardTime || ''}`
    }));
    return {
        date: marketData.date,
        note: items.length ? '' : '当日暂无涨停池数据（可能为非交易日或盘前）',
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

function loadExisting(path) {
    if (!existsSync(path)) {
        return { dailyBriefings: [], goldPoolSignals: {}, priceData: {}, limitUpScanData: null };
    }
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return { dailyBriefings: [], goldPoolSignals: {}, priceData: {}, limitUpScanData: null };
    }
}

const existing = loadExisting(outPath);

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
    fetchErrors: marketData.errors || []
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log('写入完成:', outPath);
