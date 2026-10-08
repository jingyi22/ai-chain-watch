// 判断今天（北京时间）是否为A股交易日：查询上证指数(1.000001)当日K线，有数据即为交易日。
// 用真实行情接口判断而非硬编码节假日表，天然覆盖周末+法定节假日+节后调休工作日，不需要每年手动维护。
// 输出：stdout 打印 "true" 或 "false"。网络异常时默认 "true"（宁可多跑一次流水线，也不要因网络抖动误判漏掉真实交易日的更新）。
function nowBeijing() {
    return new Date(Date.now() + 8 * 60 * 60 * 1000);
}
function todayYmdBeijing() {
    const d = nowBeijing();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

async function main() {
    const date = todayYmdBeijing();
    try {
        const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&fields1=f1&fields2=f51&klt=101&fqt=1&beg=${date}&end=${date}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const klines = (json && json.data && json.data.klines) || [];
        process.stdout.write(klines.length > 0 ? 'true' : 'false');
    } catch (e) {
        console.error('check-trading-day: 查询失败，默认视为交易日:', e.message);
        process.stdout.write('true');
    }
}

main();
