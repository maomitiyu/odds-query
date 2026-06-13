/**
 * 网页版足球赔率分析查询工具
 * 
 * 两个分析模式：
 * 1. 赔率分析 → 查 IMA 赔率数据知识库 → 输出纯赔率深度剖析报告
 * 2. 波胆分析 → 查 IMA 波胆分析数据知识库 → 输出纯赔率波胆实战分析报告
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const ImaClient = require('./ima-client');
const ReportEngine = require('./report-engine');

const config = {
  port: process.env.PORT || 3000,
  ima: {
    clientId: process.env.IMA_CLIENT_ID,
    apiKey: process.env.IMA_API_KEY,
    // 赔率分析知识库（深度剖析报告）
    dataKbId: process.env.IMA_DATA_KB_ID || 'h9agx9AD3IRojDwohbhbyeNvkLRtFkneT57krR_BJW0=',
    // 波胆分析知识库（波胆实战分析报告）
    bodanKbId: process.env.IMA_TEMPLATE_KB_ID || 'UuwMqQXPGA8vz6H4wa_xTpdTvZpO7P89EuVqajDWio8=',
  },
};

const ima = new ImaClient(config.ima.clientId, config.ima.apiKey);
const engine = new ReportEngine();
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API：查询比赛（mode: 'odds' = 赔率分析, 'bodan' = 波胆分析）
app.post('/api/query', async (req, res) => {
  const startTime = Date.now();
  const { homeTeam, awayTeam, text, mode = 'odds' } = req.body;

  // 解析输入
  let home = homeTeam;
  let away = awayTeam;

  if (!home || !away) {
    if (text) {
      const match = text.match(/(.+?)\s*(?:VS|vs|Vs|vS|对|对阵|VS\.)\s*(.+)/);
      if (match) {
        home = match[1].trim();
        away = match[2].trim();
      }
    }
  }

  if (!home || !away) {
    return res.json({
      success: false,
      error: '请输入完整的主客队名，格式：主队 VS 客队',
    });
  }

  // 根据模式选择知识库
  const kbId = mode === 'bodan' ? config.ima.bodanKbId : config.ima.dataKbId;
  const modeLabel = mode === 'bodan' ? '波胆分析' : '赔率分析';

  console.log(`🔍 [${modeLabel}] 查询: ${home} VS ${away}`);

  try {
    // 搜索知识库
    const matchData = await ima.findMatch(kbId, home, away);

    if (!matchData || !matchData.found) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return res.json({
        success: false,
        error: `未在「${modeLabel}」知识库中找到「${home} VS ${away}」的比赛数据`,
        hint: '请确认队名与知识库中一致，或切换到另一个分析模式试试',
        elapsed,
      });
    }

    // 优先使用知识库原文报告，没有则生成快速摘要
    let report = matchData.reportText || '';
    if (!report && matchData.rawText) {
      report = engine.generateQuickReport(matchData.rawText);
    }

    if (!report) {
      return res.json({
        success: false,
        error: `已找到「${home} VS ${away}」的数据，但报告生成失败`,
        hint: '请前往 IMA 知识库直接查看',
      });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ [${modeLabel}] 查询完成 (${elapsed}s): ${home} VS ${away}`);

    return res.json({
      success: true,
      mode,
      homeTeam: home,
      awayTeam: away,
      report,
      sourceFile: matchData.sourceFile,
      elapsed,
    });
  } catch (err) {
    console.error('查询失败:', err.message);
    return res.json({
      success: false,
      error: `查询知识库时出错：${err.message}`,
      hint: '请稍后重试',
    });
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: '足球赔率查询', timestamp: new Date().toISOString() });
});

app.listen(config.port, () => {
  console.log(`⚽ 足球赔率查询工具已启动 → http://localhost:${config.port}`);
});
