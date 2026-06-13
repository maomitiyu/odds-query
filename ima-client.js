/**
 * IMA OpenAPI 客户端 v2
 * 
 * 核心策略：IMA OpenAPI 搜索不索引文件内容，所以改为：
 * 1. 列出知识库文件 → 2. 直接下载 TXT 文件 → 3. 本地搜索匹配比赛
 */

const axios = require('axios');

const IMA_BASE = 'https://ima.qq.com/openapi/wiki/v1';

class ImaClient {
  constructor(clientId, apiKey) {
    this.clientId = clientId;
    this.apiKey = apiKey;
    this.cache = new Map();
    this.cacheTTL = 5 * 60 * 1000;
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      'ima-openapi-clientid': this.clientId,
      'ima-openapi-apikey': this.apiKey,
    };
  }

  async request(endpoint, body = {}) {
    const url = `${IMA_BASE}${endpoint}`;
    const res = await axios.post(url, body, { headers: this.headers() });
    if (res.data.code !== 0) {
      throw new Error(`IMA API 错误 [${res.data.code}]: ${res.data.msg}`);
    }
    return res.data.data;
  }

  async getKnowledgeList(kbId, cursor = '', limit = 10) {
    return this.request('/get_knowledge_list', { knowledge_base_id: kbId, cursor, limit });
  }

  async getMediaInfo(mediaId) {
    return this.request('/get_media_info', { media_id: mediaId });
  }

  async downloadMedia(mediaId) {
    const cached = this.cache.get(mediaId);
    if (cached && (Date.now() - cached.time < this.cacheTTL)) {
      return cached.content;
    }
    const info = await this.getMediaInfo(mediaId);
    if (!info.url_info || !info.url_info.url) throw new Error('无法获取文件下载地址');
    const res = await axios.get(info.url_info.url, {
      headers: info.url_info.headers || {},
      responseType: 'text',
      timeout: 30000,
    });
    const content = res.data;
    this.cache.set(mediaId, { content, time: Date.now() });
    return content;
  }

  /**
   * 根据主队+客队名称查找匹配的比赛数据
   */
  async findMatch(kbId, homeTeam, awayTeam) {
    const list = await this.getKnowledgeList(kbId);
    if (!list.knowledge_list || list.knowledge_list.length === 0) return null;

    for (const file of list.knowledge_list) {
      if (!file.media_id || !file.media_id.startsWith('txt_')) continue;
      try {
        const content = await this.downloadMedia(file.media_id);
        const match = this.parseMatchFromContent(content, homeTeam, awayTeam);
        if (match) {
          match.sourceFile = file.title;
          return match;
        }
      } catch (err) {
        console.error(`下载文件 ${file.title} 失败:`, err.message);
      }
    }
    return null;
  }

  /**
   * 从 TXT 文件原始内容中解析指定比赛的数据段落和原文分析报告
   *
   * 文件结构：
   *   某行：### USER          ← trim() 精确匹配
   *   后面行：用户输入内容
   *   某行：### ASSISTANT    ← trim() 精确匹配
   *   后面行：报告内容（可能含 "### 4️⃣ 价值排序"，不能误分割）
   *   某行：### USER          ← 下一场
   *
   * 正确做法：只认 trim() === '### USER' 的独立行作为段边界
   * 返回：{ rawText, reportText, homeTeam, awayTeam, found, sourceFile }
   */
  parseMatchFromContent(content, homeTeam, awayTeam) {
    let text = content;

    // 解码
    if (text.startsWith('{')) {
      try { const p = JSON.parse(text); if (p.content) text = p.content; } catch (e) {}
    }
    text = text.replace(/&#xD;/g, '\n')
               .replace(/&amp;/g, '&')
               .replace(/<[^>]+>/g, '\n')
               .replace(/\\\\n/g, '\n');

    if (!text.includes(homeTeam) || !text.includes(awayTeam)) return null;

    const lines = text.split('\n');

    // ═════════════════════════════════════════════════════════
    // 第1步：找到所有段边界的行号（只认独立行的 ### USER / ### ASSISTANT）
    // ═════════════════════════════════════════════════════════
    // markerLines: { type: 'USER'|'ASSISTANT', lineIdx }
    const markerLines = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === '### USER') {
        markerLines.push({ type: 'USER', lineIdx: i });
      } else if (t === '### ASSISTANT') {
        markerLines.push({ type: 'ASSISTANT', lineIdx: i });
      }
    }

    // ═════════════════════════════════════════════════════════
    // 第2步：按边界提取每段内容（段内容 = 边界行下一行 到 下一个边界行）
    // ═════════════════════════════════════════════════════════
    // sections: { type: 'USER'|'ASSISTANT', content }
    const sections = [];
    for (let i = 0; i < markerLines.length; i++) {
      const startLine = markerLines[i].lineIdx + 1;  // 边界行下一行
      const endLine = (i + 1 < markerLines.length)
        ? markerLines[i + 1].lineIdx               // 下一个边界行（不含）
        : lines.length;                            // 或文件末尾
      const content = lines.slice(startLine, endLine).join('\n').trim();
      sections.push({ type: markerLines[i].type, content });
    }

    // ═════════════════════════════════════════════════════════
    // 第3步：找到含目标队名的段
    // ═════════════════════════════════════════════════════════
    for (let i = 0; i < sections.length; i++) {
      const seg = sections[i];
      if (!seg.content.includes(homeTeam) || !seg.content.includes(awayTeam)) continue;

      // 格式 A：USER 段里含赔率数据（赔率数据知识库）
      if (seg.type === 'USER' && seg.content.includes('顶部赛事信息')) {
        // 找后面紧跟的 ASSISTANT 段（同场比赛的报告）
        let reportText = '';
        for (let j = i + 1; j < sections.length; j++) {
          if (sections[j].type === 'ASSISTANT' &&
              sections[j].content.includes(homeTeam) &&
              sections[j].content.includes(awayTeam)) {
            reportText = sections[j].content;
            break;
          }
        }
        if (!seg.content.includes('胜平负')) continue;
        return { rawText: seg.content, reportText, homeTeam, awayTeam, found: true };
      }

      // 格式 B：ASSISTANT 段里含完整报告（波胆分析知识库）
      if (seg.type === 'ASSISTANT') {
        return { rawText: '', reportText: seg.content, homeTeam, awayTeam, found: true };
      }
    }

    return null;
  }
}

module.exports = ImaClient;
