// 调用 OpenRouter (deepseek/deepseek-chat) 基于 fetch-market-data.mjs 抓到的真实数据生成当日复盘/早报文本。
// 严格约束：模型只能引用输入 JSON 里出现的股票名称/涨跌幅/新闻标题等事实，禁止编造任何未出现的具体数字或事件。
// 用法：node generate-briefing.mjs <morning|review> < market-data.json > briefing.json
// OPENROUTER_API_KEY 必须通过环境变量传入，脚本本身不读取/不写入任何密钥到文件。

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
    console.error('缺少环境变量 OPENROUTER_API_KEY');
    process.exit(1);
}

const type = process.argv[2];
if (type !== 'morning' && type !== 'review') {
    console.error('用法: node generate-briefing.mjs <morning|review>');
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

const SYSTEM_PROMPT = `你是一名A股AI算力产业链的行情复盘助手。你只能引用用户消息里 marketData JSON 中出现的股票名称、代码、涨跌幅、价格、新闻标题等事实；严禁编造任何未出现在 marketData 中的具体数字（涨跌幅、金额、成交量等）、未出现的新闻事件、未出现的公司名称。
如果 marketData 里某类数据为空（例如涨停池为空），对应字段就如实反映"暂无数据"或跳过该维度的具体数字描述，不要虚构填充。
所有输出必须是一个JSON对象，不要输出任何JSON之外的文字。`;

const GOLD_POOL_SIGNAL_SCHEMA = `"goldPoolSignals": [{"code":"股票代码(必须来自quotes)","signal":"一句话点评，只依据quotes里该股票的真实现价/涨跌幅，不要编造消息面原因"}]  // 覆盖 quotes 里出现的每一只股票`;

function buildUserPrompt(marketData, type) {
    const schemaNote = type === 'morning'
        ? `请生成一个"早报"对象，字段：
{
  "title": "简短标题，含日期和当日最值得关注的1-2个信息点",
  "overnightMarket": "基于marketData.news中的新闻标题整理隔夜/早间市场信息，只能引用news里出现的标题内容，不要编造具体涨跌数字",
  "keyNews": ["3-5条要点，每条基于news里的真实标题改写，不添加不存在的数字"],
  "todayAgenda": ["2-4条今日关注点，基于quotes/news真实内容"],
  "goldStockChanges": "基于quotes中金股池现价/涨跌幅的简要综述，只用quotes里的真实数字",
  "conclusion": "1段总结，只引用已给数据",
  ${GOLD_POOL_SIGNAL_SCHEMA}
}`
        : `请生成一个"收盘复盘"对象，字段：
{
  "title": "简短标题，含日期和当日最大变动",
  "marketOverview": "基于quotes与limitUpPool的真实数据整理大盘/板块概况，只用给定数字",
  "sectorHighlights": ["2-4条板块要点，只引用quotes/limitUpPool里真实存在的股票和涨跌幅"],
  "goldStockPerf": [{"code":"股票代码(必须来自quotes)","name":"股票名称","change":数字(必须等于quotes里该股票的changePct),"note":"基于该股票真实涨跌幅的简评"}],
  "conclusion": "1段总结，只引用已给数据",
  ${GOLD_POOL_SIGNAL_SCHEMA}
}`;

    return `今天是 ${marketData.date}。以下是今日真实抓取到的数据（marketData），请严格只引用其中出现的事实生成内容：

marketData = ${JSON.stringify(marketData)}

${schemaNote}

直接输出上述结构的JSON对象，不要包裹在markdown代码块里，不要添加任何解释性文字。`;
}

async function callOpenRouter(marketData, type) {
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
                { role: 'user', content: buildUserPrompt(marketData, type) }
            ],
            response_format: { type: 'json_object' },
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
    return JSON.parse(content);
}

// 校验模型输出的数字确实来自 marketData，防止编造。校验失败直接抛错（本次运行跳过写入，保留上一份数据）
function verifyNoFabrication(briefing, marketData, type) {
    const knownCodes = new Set(Object.values(marketData.quotes || {}).map(v => v.code));

    if (type === 'review' && Array.isArray(briefing.goldStockPerf)) {
        for (const g of briefing.goldStockPerf) {
            const q = marketData.quotes && Object.values(marketData.quotes).find(v => v.code === g.code);
            if (!q) throw new Error(`goldStockPerf 引用了未知代码 ${g.code}`);
            const realChange = parseFloat(q.changePct);
            if (Math.abs(parseFloat(g.change) - realChange) > 0.05) {
                throw new Error(`goldStockPerf ${g.code} 涨跌幅 ${g.change} 与真实数据 ${realChange} 不符，疑似编造`);
            }
        }
    }

    if (Array.isArray(briefing.goldPoolSignals)) {
        for (const s of briefing.goldPoolSignals) {
            if (!knownCodes.has(s.code)) {
                throw new Error(`goldPoolSignals 引用了未知代码 ${s.code}`);
            }
        }
    }
    return true;
}

async function main() {
    const raw = await readStdin();
    const marketData = JSON.parse(raw);
    const briefing = await callOpenRouter(marketData, type);
    verifyNoFabrication(briefing, marketData, type);
    briefing.date = marketData.date;
    briefing.type = type;
    process.stdout.write(JSON.stringify(briefing));
}

main().catch(e => {
    console.error('generate-briefing failed:', e.message);
    process.exit(1);
});
