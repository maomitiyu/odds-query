#!/bin/bash
# ========== 赔率分析查询工具 - 腾讯云一键部署脚本 ==========
# 在腾讯云轻量应用服务器的 OrcaTerm（网页终端）里运行

set -e
echo "========================================="
echo "  赔率分析查询工具 - 自动部署"
echo "========================================="

# 1. 更新系统 & 安装 Node.js
echo ""
echo "[1/6] 安装 Node.js ..."
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - > /dev/null 2>&1 || true
yum install -y nodejs git 2>/dev/null || apt-get update && apt-get install -y nodejs npm git 2>/dev/null
echo "Node.js 版本: $(node -v 2>/dev/null || echo 'checking...')"

# 2. 创建项目目录
echo ""
echo "[2/6] 创建项目目录 ..."
mkdir -p /root/web-query && cd /root/web-query

# 3. 写入 package.json
cat > package.json << 'PKGJSON'
{
  "name": "odds-query",
  "version": "1.0.0",
  "description": "足球赔率分析查询工具",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "axios": "^1.7.0",
    "dotenv": "^16.4.0",
    "express": "^4.21.0"
  }
}
PKGJSON

# 4. 写入 .env
cat > .env << 'ENV'
IMA_CLIENT_ID=54972ddd65f55fcea5b9345c79ca4a21
IMA_API_KEY=raf9FnN6QVYd72U51fnvw19VowuUD+t+Q/ATDO7pAm9k0g6tjHWNqApkJS7n836dQfWjcMNFRQ==
IMA_DATA_KB_ID=h9agx9AD3IRojDwohbhbyeNvkLRtFkneT57krR_BJW0=
IMA_TEMPLATE_KB_ID=UuwMqQXPGA8vz6H4wa_xTpdTvZpO7P89EuVqajDWio8=
PORT=3000
ENV

# 5. 安装依赖
echo ""
echo "[3/6] 安装依赖包 ..."
npm install --production 2>&1 | tail -3

# 6. 上传代码文件
echo ""
echo "[4/6] 部署代码文件 ..."

cat > ima-client.js << 'IMACLIENT'
const axios = require('axios');
const crypto = require('crypto');

class IMAClient {
  constructor(config) {
    this.clientId = config.clientId;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://ima.tencentcloudapi.com';
  }

  _base64UrlEncode(str) {
    return Buffer.from(str).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  _sign(method, path, query, body) {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString('hex');
    
    let bodyHash;
    if (body) {
      bodyHash = crypto.createHash('SHA256').update(body).digest('hex');
    } else {
      bodyHash = crypto.createHash('SHA256').update('').digest('hex');
    }
    
    const stringToSign = `${method}\n${path}\n${query}\n${timestamp};${nonce}\n${bodyHash}`;
    const signStr = Buffer.from(stringToSign).toString('utf-8');
    const signature = crypto.createHmac('sha256', this.apiKey).update(signStr).digest('hex');

    return {
      'X-TC-Timestamp': timestamp,
      'X-TC-Nonce': nonce,
      'Authorization': `${this._base64UrlEncode(this.clientId)};${signature}`
    };
  }

  async searchKB(kbId, query, topK = 10) {
    const kbIdEncoded = this._base64UrlEncode(kbId);
    const path = `/v1/knowledgeBases/${kbIdEncoded}/searches`;
    const method = 'POST';
    const headers = this._sign(method, path, '', JSON.stringify({ query, topK }));
    
    const resp = await axios.post(`https://ima.qcloud.com${path}`, 
      { query, topK },
      { headers, timeout: 15000 });
    return resp.data;
  }

  async getFileContent(kbId, fileId) {
    const kbIdEncoded = this._base64UrlEncode(kbId);
    const fileIdEncoded = this._base64UrlEncode(fileId);
    const url = `https://ima.qcloud.com/v1/knowledgeBases/${kbIdEncoded}/files/${fileIdEncoded}/content`;
    const method = 'GET';
    const headers = this._sign(method, url.replace('https://ima.qcloud.com', ''), '', '');
    
    const resp = await axios.get(url, { headers, timeout: 30000 });
    return resp.data;
  }

  parseMatchFromContent(content, homeTeam, awayTeam) {
    if (!content) return { found: false };
    
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Buffer.isBuffer(content)) text = content.toString('utf-8');
    else text = JSON.stringify(content);

    const lines = text.split('\n');
    const markerLines = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === '### USER') markerLines.push({ type: 'USER', lineIdx: i });
      else if (t === '### ASSISTANT') markerLines.push({ type: 'ASSISTANT', lineIdx: i });
    }

    const sections = [];
    for (let i = 0; i < markerLines.length; i++) {
      const startLine = markerLines[i].lineIdx + 1;
      const endLine = (i + 1 < markerLines.length) ? markerLines[i + 1].lineIdx : lines.length;
      sections.push({
        type: markerLines[i].type,
        content: lines.slice(startLine, endLine).join('\n').trim()
      });
    }

    const homeNorm = (homeTeam || '').toLowerCase().replace(/[\s\-_]/g, '');
    const awayNorm = (awayTeam || '').toLowerCase().replace(/[\s\-_]/g, '');

    for (const sec of sections) {
      const c = sec.content.toLowerCase();
      const hasHome = homeNorm ? c.includes(homeNorm) || sec.content.includes(homeTeam) : true;
      const hasAway = awayNorm ? c.includes(awayNorm) || sec.content.includes(awayTeam) : true;

      if ((hasHome || hasAway) && sec.type === 'USER' && sec.content.includes('顶部赛事信息')) {
        return { rawText: sec.content, reportText: null, homeTeam, awayTeam, found: true };
      }

      if (sec.type === 'ASSISTANT' && (hasHome || hasAway)) {
        return { rawText: sec.content, reportText: sec.content, homeTeam, awayTeam, found: true };
      }
    }

    return { rawText: text.substring(0, 200), reportText: null, homeTeam, awayTeam, found: false };
  }

  async findMatch(kbId, homeTeam, awayTeam) {
    const queries = [
      `${homeTeam} ${awayTeam}`,
      `${awayTeam} ${homeTeam}`,
      homeTeam,
      awayTeam
    ];

    for (const q of queries) {
      try {
        const result = await this.searchKB(kbId, q, 5);
        if (result?.data?.files && result.data.files.length > 0) {
          for (const f of result.data.files) {
            try {
              const fileContent = await this.getFileContent(kbId, f.fileId);
              const matchData = this.parseMatchFromContent(fileContent, homeTeam, awayTeam);
              if (matchData.found) return matchData;
            } catch (e) {}
          }
          
          // If no exact match but files exist, get first file
          if (!this._lastFileId) {
            try {
              const fileContent = await this.getFileContent(kbId, result.data.files[0].fileId);
              this._lastFileId = result.data.files[0].fileId;
              const matchData = this.parseMatchFromContent(fileContent, homeTeam, awayTeam);
              return matchData;
            } catch (e) {
              return { found: false, error: e.message };
            }
          }
        }
      } catch (e) {}
    }
    return { found: false, error: '未找到匹配数据' };
  }
}

module.exports = IMAClient;
IMACLIENT

cat > server.js << 'SERVERJS'
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const IMAClient = require('./ima-client.js');

const app = express();
app.use(bodyParser.json());
app.use(express.static(__dirname + '/public'));

const config = {
  clientId: process.env.IMA_CLIENT_ID,
  apiKey: process.env.IMA_API_KEY,
};
const ima = new IMAClient(config);
const dataKbId = process.env.IMA_DATA_KB_ID;
const bodanKbId = process.env.IMA_TEMPLATE_KB_ID;

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

app.post('/api/query', async (req, res) => {
  try {
    const { homeTeam, awayTeam, mode } = req.body;
    if (!homeTeam || !awayTeam) return res.json({ ok: false, error: '请输入主队和客队名称' });

    const kbId = mode === 'bodan' ? bodanKbId : dataKbId;
    const modeLabel = mode === 'bodan' ? '波胆分析' : '赔率分析';

    const startTime = Date.now();
    const matchData = await ima.findMatch(kbId, homeTeam.trim(), awayTeam.trim());
    const elapsedMs = Date.now() - startTime;

    if (matchData.found) {
      const report = matchData.reportText || matchData.rawText || '';
      return res.json({
        ok: true,
        mode: modeLabel,
        homeTeam: matchData.homeTeam || homeTeam,
        awayTeam: matchData.awayTeam || awayTeam,
        report: report,
        elapsed: `${elapsedms / 1000}s`,
      });
    } else {
      return res.json({
        ok: false,
        error: `未在「${modeLabel}」知识库中找到「${homeTeam} VS ${awayTeam}」的比赛数据\n\n请确认队名与知识库中一致，或切换到另一个分析模式试试`,
        mode: modeLabel,
      });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: '查询出错：' + e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://0.0.0.0:${PORT}`));
SERVERJS

mkdir -p public
cat > public/index.html << 'HTML'
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>赔率分析查询</title>
<style>
:root{--bg-primary:#12161e;--bg-card:#1a202c;--border:#2a3548;--gold:#f0a500;--gold-dim:rgba(240,165,0,0.08);--text-primary:#e8ecf1;--text-secondary:#9aa3b3;--text-dim:#606a7d}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;background:var(--bg-primary);min-height:100vh;color:var(--text-primary);font-size:16px}.topbar{text-align:center;padding:24px 20px 12px;background:linear-gradient(180deg,#1a2030 0%,var(--bg-primary) 100%)}
.topbar h1{font-size:22px;font-weight:600;color:var(--text-primary);letter-spacing:.5px}.subtitle{text-align:center;font-size:14px;color:var(--text-dim);margin-bottom:20px}
.container{max-width:600px;margin:0 auto;padding:0 16px 40px}
.mode-bar{display:flex;background:rgba(255,255,255,0.04);border-radius:8px;padding:3px;margin-bottom:18px;border:1px solid var(--border)}
.mode-btn{flex:1;padding:10px 0;background:none;border:none;border-radius:7px;color:var(--text-secondary);font-size:15px;font-weight:500;cursor:pointer;transition:.2s}.mode-btn.active{background:var(--gold);color:#0b1420;font-weight:600}
.input-row{display:flex;gap:8px;margin-bottom:8px}.input-row input{flex:1;height:42px;padding:0 13px;background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:15px;outline:none;transition:border-color .2s}
.input-row input:focus,.input-single:focus{border-color:var(--gold)}.input-single{width:100%;height:42px;padding:0 13px;background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:15px;outline:none;transition:border-color .2s;margin-bottom:4px}
.btn-search{width:100%;height:44px;margin-top:12px;background:var(--gold);border:none;border-radius:8px;color:#0b1420;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s}.btn-search:hover{opacity:.85}
.examples{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.examples button{padding:5px 12px;background:transparent;border:1px solid var(--border);border-radius:5px;color:var(--text-secondary);font-size:13px;cursor:pointer;transition:.15s}.examples button:hover{border-color:var(--gold);color:var(--gold)}
.loading{display:none;text-align:center;padding:30px}.loading p{color:var(--text-secondary);font-size:14px;margin-top:10px}
.spinner{display:inline-block;width:32px;height:32px;border:3px solid rgba(240,165,0,0.15);border-top:var(--gold);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.result{display:none}.result-card{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.result-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:14px 18px;border-bottom:1px solid var(--border);background:rgba(255,255,255,0.02)}
.result-header .match-tag{display:inline-flex;align-items:center;gap:6px;background:var(--gold-dim);border:1px solid rgba(240,165,0,0.18);border-radius:6px;padding:5px 14px;font-size:14px;color:var(--gold);font-weight:500}
.result-header .mode-label{font-size:13px;color:var(--text-dim);background:rgba(255,255,255,0.04);border-radius:4px;padding:4px 10px}
.result-header .elapsed{font-size:13px;color:var(--text-dim)}
.report-content{padding:20px;max-height:75vh;overflow-y:auto;font-size:15px;line-height:1.9;color:var(--text-primary)}
.report-content h1{font-size:19px;color:var(--gold);margin:16px 0 10px;font-weight:600}
.report-content h2{font-size:17px;color:var(--text-primary);margin:14px 0 8px;font-weight:600}
.report-content h3{font-size:16px;color:var(--text-secondary);margin:10px 0 6px}
.report-content p{margin:6px 0;color:var(--text-secondary)}
.report-content table{width:100%;border-collapse:collapse;margin:10px 0;font-size:14px}
.report-content th,.report-content td{padding:7px 10px;border:1px solid var(--border);text-align:left}
.report-content code{background:rgba(255,255,255,0.06);padding:2px 6px;border-radius:3px;font-size:14px;color:var(--gold)}
.report-content pre{background:rgba(0,0,0,0.3);border-radius:6px;padding:12px;font-size:14px;line-height:1.6;color:var(--text-secondary);overflow-x:auto;margin:10px 0}
.report-content blockquote{border-left:3px solid var(--gold);padding:6px 12px;margin:10px 0;background:var(--gold-dim);border-radius:0 5px 5px 0;color:var(--text-secondary);font-size:14px}
.report-content ul,.report-content ol{padding-left:20px;margin:6px 0}
.report-content li{margin:3px 0;color:var(--text-secondary);font-size:14px}
.source-bar{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;border-top:1px solid var(--border);background:rgba(0,0,0,0.15);font-size:13px;color:var(--text-dim)}
.footer{text-align:center;padding:28px 20px 20px;font-size:13px;color:var(--text-dim)}
.error-msg{display:none;background:rgba(232,64,64,0.08);border:1px solid rgba(232,64,64,0.2);border-radius:8px;padding:10px 14px;margin-top:14px;color:#e84040;font-size:14px;line-height:1.6}
@media screen and (max-width:768px){body{font-size:17px}.topbar h1{font-size:24px}.subtitle{font-size:15px}.mode-btn{font-size:16px;padding:11px 0}.input-row input,.input-single{font-size:16px;height:44px}.btn-search{font-size:17px;height:46px}.examples button{font-size:14px;padding:6px 14px}.result-header .match-tag{font-size:15px}.result-header .mode-label,.result-header .elapsed{font-size:14px}.report-content{font-size:16px;line-height:2;padding:20px}.report-content h1{font-size:20px}.report-content h2{font-size:18px}.report-content h3{font-size:17px}.report-content table{font-size:15px}.report-content pre{font-size:15px}.report-content li{font-size:15px}.source-bar{font-size:14px}}
</style>
</head>
<body>
<div class="topbar"><h1>⚽ 赔率分析查询</h1><p class="subtitle">输入主客队名称，获取深度分析报告</p></div>
<div class="container">
<div class="mode-bar"><button class="mode-btn active" onclick="setMode('odds')">📊 赔率分析</button><button class="mode-btn" onclick="setMode('bodan')">🎯 波胆分析</button></div>
<div class="input-row"><input id="homeTeam" placeholder="主队" autocomplete="off"><input id="awayTeam" placeholder="客队" autocomplete="off"></div>
<button class="btn-search" onclick="doQuery()">🔍 查询报告</button>
<div class="examples"><button onclick="fill('威尔士','加纳')">威尔士 VS 加纳</button><button onclick="fill('加拿大','波黑')">加拿大 VS 波黑</button><button onclick="fill('葡萄牙','克罗地亚')">葡萄牙 VS 克罗地亚</button></div>
<div class="loading" id="loading"><div class="spinner"></div><p>正在查询知识库...</p></div>
<div class="error-msg" id="errorMsg"></div>
<div class="result" id="result"><div class="result-card"><div class="result-header"><span class="match-tag" id="matchTag">⚽ 查询结果</span><span class="mode-label" id="resMode">赔率分析</span><span class="elapsed" id="elapsed"></span></div><div class="report-content" id="report"></div><div class="source-bar"><span>来源：IMA 知识库</span><span id="timeStamp"></span></div></div></div>
<div class="footer">猫咪体育 © 2026 · 数据来源：腾讯 IMA 知识库</div>
</div>
<script>
let currentMode='odds';function setMode(m){currentMode=m;document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));event.target.classList.add('active')}
function fill(h,a){document.getElementById('homeTeam').value=h;document.getElementById('awayTeam').value=a}
function doQuery(){const h=document.getElementById('homeTeam').value.trim();const a=document.getElementById('awayTeam').value.trim();if(!h||!a){showError('请输入主队和客队名称');return}hideAll();document.getElementById('loading').style.display='block';fetch('/api/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({homeTeam:h,awayTeam:a,mode:currentMode})}).then(r=>r.json()).then(d=>{hideAll();if(d.ok){document.getElementById('result').style.display='block';document.getElementById('matchTag').innerHTML='⚽ '+d.homeTeam+' VS '+d.awayTeam;document.getElementById('resMode').textContent=d.mode;document.getElementById('elapsed').textContent=d.elapsed;renderReport(document.getElementById('report'),d.report||'');document.getElementById('timeStamp').textContent=new Date().toLocaleString()}else showError(d.error||'查询失败')}).catch(e=>{hideAll();showError('网络错误：'+e.message)})}
function renderReport(el,text){el.innerHTML=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>').replace(/#{1,6}\s(.+)/g,'<h3>$1</h3>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')}
function hideAll(){document.getElementById('loading').style.display='none';document.getElementById('result').style.display='none';document.getElementById('errorMsg').style.display='none'}
function showError(msg){hideAll();document.getElementById('errorMsg').style.display='block';document.getElementById('errorMsg').textContent=msg}
</script>
</body></html>
HTML

echo ""
echo "[5/6] 代码部署完成！"

# 7. 启动服务
echo ""
echo "[6/6] 启动服务 ..."
nohup node server.js > /root/web-query/server.log 2>&1 &
sleep 2
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 && echo " -> 服务启动成功！" || echo " -> 服务启动中..."

echo ""
echo "========================================="
echo "  ✅ 部署完成！"
echo "  访问地址: http://124.221.10.132:3000"
echo "========================================="
