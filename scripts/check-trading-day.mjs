// 判断（北京时间）某日是否为A股交易日：查询上证指数(1.000001)当日K线，有数据即为交易日。
// 用真实行情接口判断而非硬编码节假日表，天然覆盖周末+法定节假日+节后调休工作日，不需要每年手动维护。
//
// 用法: node check-trading-day.mjs [morning|review]
// review 类型会在"今天"查无数据时向前回溯（最多7天），因为 GitHub Actions 的 cron 经常延迟数小时触发，
// 一旦延迟跨过北京时间午夜，nowBeijing() 算出的"今天"就滚到了新的一天——而新的一天此刻还没开盘，
// 查不到K线，会被误判为"非交易日"从而跳过整条流水线，导致前一个真实交易日的收盘复盘永远生成不出来。
// morning 类型不回溯：早报本来就是在当天开盘前生成，"今天查不到"是预期状态的一部分，不代表要去查昨天。
//
// 输出：stdout 打印 JSON {"isTradingDay": bool, "date": "YYYYMMDD"}（date 为回溯后实际命中的交易日，
// morning 类型或未命中回溯时就是"今天"）。网络异常时默认视为交易日（宁可多跑一次流水线，也不要因网络抖动
// 误判漏掉真实交易日的更新）。
const type = process.argv[2] || 'morning';
const MAX_LOOKBACK_DAYS = 7;

function nowBeijing() {
    return new Date(Date.now() + 8 * 60 * 60 * 1000);
}
function ymd(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

async function hasKline(date) {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&fields1=f1&fields2=f51&klt=101&fqt=1&beg=${date}&end=${date}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const klines = (json && json.data && json.data.klines) || [];
        return klines.length > 0;
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    const base = nowBeijing();
    try {
        for (let back = 0; back <= (type === 'review' ? MAX_LOOKBACK_DAYS : 0); back++) {
            const d = new Date(base.getTime() - back * 24 * 60 * 60 * 1000);
            const date = ymd(d);
            if (await hasKline(date)) {
                process.stdout.write(JSON.stringify({ isTradingDay: true, date }));
                return;
            }
        }
        process.stdout.write(JSON.stringify({ isTradingDay: false, date: ymd(base) }));
    } catch (e) {
        console.error('check-trading-day: 查询失败，默认视为交易日:', e.message);
        process.stdout.write(JSON.stringify({ isTradingDay: true, date: ymd(base) }));
    }
}

main();
