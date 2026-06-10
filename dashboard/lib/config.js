'use strict';

const fs = require('fs');

/**
 * config.json を読み込んでパースする。
 * リクエスト毎に呼ばれる（再起動なしで設定変更を反映するため）。
 * @param {string} configPath config.json の絶対パス
 * @returns {object} パース済み設定
 */
function readConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

/**
 * クライアントへ渡してよい範囲だけを抽出する。
 * serverOnly（パス・スクリプト・起動コマンド等の内部情報）は一切含めない。
 * agents は label/color のみに絞る。
 * @param {object} config 完全な設定
 * @returns {object} 公開用にサニタイズした設定
 */
function sanitizePublicConfig(config) {
  const agents = {};
  for (const [agentId, agent] of Object.entries(config.agents || {})) {
    agents[agentId] = {
      label: agent.label || agentId,
      color: agent.color || '#6B7280'
    };
  }

  return {
    siteTitle: config.siteTitle || 'Dashboard',
    teamName: config.teamName || 'Team',
    timezone: config.timezone || 'Asia/Tokyo',
    polling: config.polling || { taskIntervalSec: 30 },
    heartbeat: config.heartbeat || { enabled: true, excludeBlocked: true },
    ui: config.ui || { mobileBreakpoint: 768, showCopyButtonsOnMobile: false, desktopColumns: 3, completedPreviewCount: 8 },
    agents
  };
}

module.exports = { readConfig, sanitizePublicConfig };
