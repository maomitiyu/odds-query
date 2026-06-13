/**
 * 报告生成引擎 v2
 * 适配 IMA 知识库 conversations 格式：
 * ### USER → 比赛标题 + 原始赔率数据 → ### ASSISTANT → AI分析报告
 */

class ReportEngine {

  /**
   * 从原始文本中解析比赛赔率数据
   * 数据格式说明：
   * - 比分：无分隔符，如 "1:06.75" = 比分1:0、赔率6.75
   * - 进球数："0 球9.5" = 0球赔率9.5
   * - 让球盘："让球 (-1)" = 主队让1球
   * - 所有分隔符为 " | "
   */
  parseOddsData(rawText) {
    const data = {};
    const text = rawText;

    // 解析头部赛事信息
    // 格式：联赛 | 日期 时间 星期 | 主队 (主) VS 客队 | 场地：xxx | 天气：xxx | 温度：xxx
    const headerMatch = text.match(/顶部赛事信息[\s\S]*?([^|\n]+)\s*\|\s*(.+?星期[\u4e00-\u9fa5]*)\s*\|\s*(.+?)\s*VS\s*(.+?)\s*\|/);
    if (headerMatch) {
      data.league = headerMatch[1].trim();
      data.datetime = headerMatch[2].trim();
      data.homeTeam = headerMatch[3].replace(/\(主\)/g, '').trim();
      data.awayTeam = headerMatch[4].trim();
    }

    // 场地/天气
    const venueMatch = text.match(/场地[：:](.+?)\s*[|\n]/);
    if (venueMatch) data.venue = venueMatch[1].trim();

    // 解析胜平负
    const spfMatch = text.match(/胜平负[：:]\s*胜([\d.]+)\s*\|\s*平([\d.]+)\s*\|\s*负([\d.]+)/);
    if (spfMatch) {
      data.spf = { win: parseFloat(spfMatch[1]), draw: parseFloat(spfMatch[2]), lose: parseFloat(spfMatch[3]) };
    }

    // 解析让球盘
    const rqMatch = text.match(/让球\s*\(([+-]?\d+)\)[：:]\s*让胜([\d.]+)\s*\|\s*让平([\d.]+)\s*\|\s*让负([\d.]+)/);
    if (rqMatch) {
      data.rqspf = { handicap: parseInt(rqMatch[1]), rqWin: parseFloat(rqMatch[2]), rqDraw: parseFloat(rqMatch[3]), rqLose: parseFloat(rqMatch[4]) };
    }

    // 解析进球数："0 球9.5 | 1 球4.1 | 2 球3.25 ..."
    const goalsMatch = text.match(/进球数[：:]\s*(.+)/);
    if (goalsMatch) {
      data.goals = {};
      const goalRe = /(\d+)\s*[+＋]?\s*球\s*([\d.]+)/g;
      let gMatch;
      while ((gMatch = goalRe.exec(goalsMatch[1])) !== null) {
        data.goals[gMatch[1]] = parseFloat(gMatch[2]);
      }
    }

    // 解析比分波胆 — 处理无分隔符格式
    // 格式："1:06.75 | 2:09.5 | 2:17.5 | 3:020 | ..."
    // 比分规则：X:Y 之后紧跟赔率数字
    data.scores = { home: {}, draw: {}, away: {} };

    const parseScoreSection = (sectionText, type) => {
      const scores = {};
      // 处理无分隔符格式："1:06.75 | 2:09.5 | 3:020"
      // 比分规则：X:Y（Y通常1位），后面紧跟赔率数字
      const scoreRe = /(\d+):(\d)([\d.]+)/g;
      let m;
      while ((m = scoreRe.exec(sectionText)) !== null) {
        const score = `${m[1]}:${m[2]}`;
        const odds = parseFloat(m[3]);
        if (odds > 1) { // 赔率必须 > 1
          scores[score] = odds;
        }
      }
      return scores;
    };

    // 分割比分区域
    const homeScoreSplit = text.indexOf('主胜比分');
    const drawScoreSplit = text.indexOf('平局比分');
    const awayScoreSplit = text.indexOf('客胜比分');
    const halfFullSplit = text.indexOf('半全场');

    if (homeScoreSplit !== -1 && drawScoreSplit !== -1 && awayScoreSplit !== -1) {
      const homeSection = text.substring(homeScoreSplit + 4, drawScoreSplit);
      const drawSection = text.substring(drawScoreSplit + 4, awayScoreSplit);
      const awaySection = text.substring(awayScoreSplit + 4, halfFullSplit !== -1 ? halfFullSplit : text.length);

      data.scores.home = parseScoreSection(homeSection, 'home');
      data.scores.draw = parseScoreSection(drawSection, 'draw');
      data.scores.away = parseScoreSection(awaySection, 'away');
    }

    // 解析半全场
    const hfMatch = text.match(/半全场[\s\S]*?([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
    if (hfMatch) {
      const labels = ['胜/胜', '胜/平', '胜/负', '平/胜', '平/平', '平/负', '负/胜', '负/平', '负/负'];
      data.halfFull = {};
      labels.forEach((label, i) => {
        data.halfFull[label] = parseFloat(hfMatch[i + 1]);
      });
    }

    // 解析 Crow 全场数据
    const crowWinMatch = text.match(/独赢[：:]\s*胜([\d.]+)\s*\|\s*平([\d.]+)\s*\|\s*负([\d.]+)/);
    if (crowWinMatch) {
      data.crow = data.crow || {};
      data.crow.spf = { win: parseFloat(crowWinMatch[1]), draw: parseFloat(crowWinMatch[2]), lose: parseFloat(crowWinMatch[3]) };
    }

    const crowAsianMatch = text.match(/亚让[：:]([\s\S]*?)主队\s*([\d.]+)\s*\|\s*盘口\s*([\d\/\-.+]+)\s*\|\s*客队\s*([\d.]+)/);
    if (crowAsianMatch) {
      data.crow = data.crow || {};
      data.crow.asian = { homeWater: parseFloat(crowAsianMatch[2]), handicap: crowAsianMatch[3].trim(), awayWater: parseFloat(crowAsianMatch[4]) };
    }

    // Crow 进球数（大小球）
    const crowGoalsMatch = text.match(/进球数[：:]\s*大球赔率\s*([\d.]+)\s*\|\s*盘口\s*([\d\/.]+)\s*\|\s*小球赔率\s*([\d.]+)/);
    if (crowGoalsMatch) {
      data.crow = data.crow || {};
      data.crow.goals = { overWater: parseFloat(crowGoalsMatch[1]), line: crowGoalsMatch[2].trim(), underWater: parseFloat(crowGoalsMatch[3]) };
    }

    // Crow 波胆
    data.crowBodan = { home: {}, draw: {}, away: {} };
    const bodyHomeMatch = text.match(/波胆\s*-\s*主队[\s\S]*?((?:\d+:\d+\s*[\d.]+\s*\|?\s*)+)/);
    if (bodyHomeMatch) {
      data.crowBodan.home = parseScoreSection(bodyHomeMatch[1], 'home');
    }
    const bodyAwayMatch = text.match(/波胆\s*-\s*客队[\s\S]*?((?:\d+:\d+\s*[\d.]+\s*\|?\s*)+)/);
    if (bodyAwayMatch) {
      data.crowBodan.away = parseScoreSection(bodyAwayMatch[1], 'away');
    }
    const bodyDrawMatch = text.match(/波胆\s*-\s*平局[\s\S]*?((?:\d+:\d+\s*[\d.]+\s*\|?\s*)+)/);
    if (bodyDrawMatch) {
      data.crowBodan.draw = parseScoreSection(bodyDrawMatch[1], 'draw');
    }

    // 入球数区间
    const intervalMatch = text.match(/入球数区间[\s\S]*?0~1\s*球\s*([\d.]+)[\s\S]*?2~3\s*球\s*([\d.]+)[\s\S]*?4~6\s*球\s*([\d.]+)/);
    if (intervalMatch) {
      data.crow = data.crow || {};
      data.crow.intervals = {
        low: parseFloat(intervalMatch[1]),
        mid: parseFloat(intervalMatch[2]),
        high: parseFloat(intervalMatch[3]),
      };
    }

    // 半场数据
    const halfWinMatch = text.match(/半场数据[\s\S]*?独赢[：:]\s*胜([\d.]+)\s*\|\s*平([\d.]+)\s*\|\s*负([\d.]+)/);
    if (halfWinMatch) {
      data.crow = data.crow || {};
      data.crow.half = { spf: { win: parseFloat(halfWinMatch[1]), draw: parseFloat(halfWinMatch[2]), lose: parseFloat(halfWinMatch[3]) } };
    }

    return data;
  }

  /**
   * 生成快速分析摘要
   */
  generateQuickReport(rawText) {
    const data = this.parseOddsData(rawText);

    if (!data.spf) {
      return null;
    }

    const home = data.homeTeam || '主队';
    const away = data.awayTeam || '客队';

    let report = [];

    // 标题
    report.push(`⚽ ${data.league || '赛事'} | ${data.datetime || ''}`);
    report.push(`${home} (主) VS ${away}`);
    if (data.venue) report.push(`📍 ${data.venue}`);
    report.push('');

    // 竞彩数据
    report.push('━━━ 📊 竞彩官方数据 ━━━');
    report.push(`胜平负：${data.spf.win} | ${data.spf.draw} | ${data.spf.lose}`);
    if (data.rqspf) {
      report.push(`让球(${data.rqspf.handicap > 0 ? '+' : ''}${data.rqspf.handicap})：${data.rqspf.rqWin} | ${data.rqspf.rqDraw} | ${data.rqspf.rqLose}`);
    }
    if (data.goals && Object.keys(data.goals).length > 0) {
      report.push(`进球数：${Object.entries(data.goals).map(([n, o]) => `${n}球 ${o}`).join(' | ')}`);
    }
    report.push('');

    // 竞彩波胆 TOP 5
    const allScores = [];
    for (const type of ['home', 'draw', 'away']) {
      if (data.scores[type]) {
        for (const [score, odds] of Object.entries(data.scores[type])) {
          if (odds > 0) allScores.push({ score, odds, type });
        }
      }
    }
    allScores.sort((a, b) => a.odds - b.odds);
    if (allScores.length > 0) {
      report.push('🔝 波胆 TOP 5（竞彩最低赔 → 最高概率）：');
      allScores.slice(0, 5).forEach((s, i) => {
        const prob = ((1 / s.odds) * 100).toFixed(1);
        const label = s.type === 'home' ? `${home}胜` : s.type === 'away' ? `${away}胜` : '平';
        report.push(`  ${i + 1}. ${s.score} (${label}) 赔率${s.odds} 概率≈${prob}%`);
      });
    }
    report.push('');

    // Crow 参考数据
    if (data.crow && data.crow.spf) {
      report.push('━━━ 🏦 Crown 参考指数 ━━━');
      const c = data.crow;
      report.push(`欧赔：${c.spf.win} | ${c.spf.draw} | ${c.spf.lose}`);
      if (c.asian) {
        report.push(`亚盘：${c.asian.handicap}  主水${c.asian.homeWater} / 客水${c.asian.awayWater}`);
      }
      if (c.goals) {
        report.push(`大小球：${c.goals.line}  大${c.goals.overWater} / 小${c.goals.underWater}`);
      }
      report.push('');

      // 核心信号
      report.push('━━━ 🔍 核心信号 ━━━');

      const jcHomeProb = (1 / data.spf.win * 100);
      const crowHomeProb = (1 / c.spf.win * 100);
      const diff = Math.abs(jcHomeProb - crowHomeProb);
      if (diff > 5) {
        report.push(`⚠️ 竞彩与Crown主胜概率差${diff.toFixed(1)}%，存在定价分歧`);
      } else {
        report.push(`✅ 竞彩与Crown方向一致（主胜概率差${diff.toFixed(1)}%）`);
      }

      if (c.asian) {
        const waterDiff = Math.abs(c.asian.homeWater - c.asian.awayWater);
        const lowSide = c.asian.homeWater < c.asian.awayWater ? home : away;
        if (waterDiff > 0.1) {
          report.push(`⚠️ 亚盘水位倾斜：${lowSide}低水，机构倾向${lowSide}方向（差${waterDiff.toFixed(2)}基点）`);
        } else {
          report.push('⚪ 亚盘水位基本平衡，机构态度中性');
        }
      }

      if (c.goals && c.goals.underWater < 0.92) {
        report.push(`🔻 小球低水${c.goals.underWater}，机构倾向≤${c.goals.line}球`);
      } else if (c.goals && c.goals.overWater < 0.92) {
        report.push(`🔺 大球低水${c.goals.overWater}，机构倾向≥${c.goals.line}球`);
      }

      // 1:1检测
      if (data.crowBodan && data.crowBodan.draw && data.crowBodan.draw['1:1']) {
        const jc11 = data.scores.draw['1:1'];
        const crow11 = data.crowBodan.draw['1:1'];
        if (jc11 && crow11 && jc11 < 6.0) {
          report.push(`📌 1:1波胆竞彩${jc11}/Crown${crow11}，机构有意防范高频平局`);
        }
      }
    }

    report.push('');
    report.push('━━━━━━━━━━━━━━━━━━');
    report.push('⚠️ 以上为快速赔率摘要，完整波动实战分析请移步 IMA 知识库查看。');

    return report.join('\n');
  }
}

module.exports = ReportEngine;
