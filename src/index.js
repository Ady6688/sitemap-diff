/**
 * Cloudflare Workers 主入口文件
 * 对应原 Python 项目的 site-bot.py
 */

import { initConfig, validateConfig } from './config.js';
import { RSSManager } from './services/rss-manager.js';
import {
  sendUpdateNotification,
  sendKeywordsSummary,
  handleTelegramUpdate
} from './apps/telegram-bot.js';
import { handleDiscordInteraction } from './apps/discord-bot.js';

// 全局变量
let rssManager = null;

/**
 * 初始化应用
 * @param {Object} env - 环境变量
 */
function initializeApp(env) {
  console.log('🚀 初始化 Site Bot...');

  // 初始化配置
  initConfig(env);

  // 验证配置
  const validation = validateConfig();
  if (!validation.isValid) {
    console.error('❌ 配置验证失败:', validation.errors);
    throw new Error(`配置错误: ${validation.errors.join(', ')}`);
  }

  // 初始化 RSS 管理器
  if (env.SITEMAP_STORAGE) {
    rssManager = new RSSManager(env.SITEMAP_STORAGE);
    console.log('✅ RSS 管理器初始化成功');
  } else {
    console.warn('⚠️ 未配置 KV 存储，某些功能可能不可用');
  }

  console.log('✅ Site Bot 初始化完成');
}

/**
 * 执行定时监控任务（分批处理版本）
 * @param {Object} env - 环境变量
 */
async function performScheduledMonitoring(env) {
  try {
    console.log('⏰ 开始执行定时监控任务...');

    if (!rssManager) {
      console.error('❌ RSS 管理器未初始化');
      return;
    }

    const feeds = await rssManager.getFeeds();
    console.log(`📊 总共 ${feeds.length} 个订阅源`);

    if (feeds.length === 0) {
      console.log('📭 没有配置的订阅源');
      return;
    }

    // 分批处理配置
    const BATCH_SIZE = 25; // 每次处理25个sitemap（进一步提高）
    const PROCESSING_KEY = 'monitoring_progress';

    // 获取上次处理的位置
    let lastIndex = 0;
    try {
      const progressData = await rssManager.kv.get(PROCESSING_KEY);
      if (progressData) {
        const progress = JSON.parse(progressData);
        lastIndex = progress.lastIndex || 0;
      }
    } catch (error) {
      console.warn('⚠️ 获取处理进度失败，从头开始:', error);
    }

    // 计算本次处理的范围
    const startIndex = lastIndex;
    const endIndex = Math.min(startIndex + BATCH_SIZE, feeds.length);
    const currentBatch = feeds.slice(startIndex, endIndex);

    console.log(`📦 处理批次: ${startIndex + 1}-${endIndex}/${feeds.length}`);

    // 用于存储所有新增的URL
    const allNewUrls = [];

    for (let i = 0; i < currentBatch.length; i++) {
      const url = currentBatch[i];
      try {
        console.log(`🔍 正在检查订阅源 [${startIndex + i + 1}/${feeds.length}]: ${url}`);

        const result = await rssManager.addFeed(url);

        if (result.success) {
          // 获取 sitemap 内容用于发送
          let sitemapContent = null;
          if (result.datedFile) {
            const domain = new URL(url).hostname;
            sitemapContent = await rssManager.getSitemapContent(domain, 'dated');
          }

          // 只有在有新URL时才发送更新通知
          if (result.newUrls && result.newUrls.length > 0) {
            await sendUpdateNotification(url, result.newUrls, sitemapContent);
            console.log(`✨ 订阅源 ${url} 更新成功，发现 ${result.newUrls.length} 个新URL`);
            allNewUrls.push(...result.newUrls);
          } else {
            console.log(`✅ 订阅源 ${url} 更新成功，无新增URL（静默模式）`);
          }
        } else {
          console.warn(`⚠️ 订阅源 ${url} 更新失败: ${result.errorMsg}`);
        }

        // 减少延迟，避免CPU超时
        if (i < currentBatch.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200)); // 减少到200ms
        }

      } catch (error) {
        console.error(`❌ 检查订阅源失败: ${url}`, error);
      }
    }

    // 更新处理进度
    const nextIndex = endIndex >= feeds.length ? 0 : endIndex; // 循环处理
    try {
      await rssManager.kv.put(PROCESSING_KEY, JSON.stringify({
        lastIndex: nextIndex,
        lastUpdate: new Date().toISOString(),
        totalFeeds: feeds.length,
        processedInThisBatch: currentBatch.length
      }));
      console.log(`📝 已更新处理进度: 下次从索引 ${nextIndex} 开始`);
    } catch (error) {
      console.error('❌ 保存处理进度失败:', error);
    }

    // 发送关键词汇总（只在有新URL时）
    if (allNewUrls.length > 0) {
      console.log(`📊 发送关键词汇总，共 ${allNewUrls.length} 个新URL`);
      await sendKeywordsSummary(allNewUrls);
    }

    if (nextIndex === 0) {
      console.log('🔄 本轮监控完成，下次将从头开始');
    } else {
      console.log(`⏳ 批次处理完成，剩余 ${feeds.length - nextIndex} 个待处理`);
    }

    console.log('✅ 定时监控任务完成');

  } catch (error) {
    console.error('❌ 定时监控任务失败:', error);
  }
}

/**
 * 处理 HTTP 请求
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @param {Object} ctx - 上下文对象
 * @returns {Response} 响应对象
 */
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    // 健康检查
    if (path === '/health') {
      return new Response(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'site-bot',
        version: '1.0.0'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 手动触发监控
    if (path === '/monitor' && request.method === 'POST') {
      ctx.waitUntil(performScheduledMonitoring(env));
      return new Response(JSON.stringify({
        status: 'success',
        message: '监控任务已启动',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Telegram Webhook
    if (path === '/webhook/telegram' && request.method === 'POST') {
      const update = await request.json();
      const result = await handleTelegramUpdate(update, rssManager);

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Discord Webhook
    if (path === '/webhook/discord' && request.method === 'POST') {
      const interaction = await request.json();
      const result = await handleDiscordInteraction(interaction, rssManager);

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // API 状态
    if (path === '/api/status') {
      const feeds = rssManager ? await rssManager.getFeeds() : [];
      return new Response(JSON.stringify({
        status: 'running',
        feeds: feeds,
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 默认响应
    return new Response(JSON.stringify({
      message: 'Site Bot API',
      endpoints: [
        '/health - 健康检查',
        '/monitor - 手动触发监控 (POST)',
        '/webhook/telegram - Telegram Webhook',
        '/webhook/discord - Discord Webhook',
        '/api/status - API 状态'
      ],
      timestamp: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('处理请求失败:', error);
    return new Response(JSON.stringify({
      error: 'Internal Server Error',
      message: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Cloudflare Workers 事件处理器
export default {
  // 处理 HTTP 请求
  async fetch(request, env, ctx) {
    // 确保应用已初始化
    if (!rssManager) {
      try {
        initializeApp(env);
      } catch (error) {
        return new Response(JSON.stringify({
          error: 'Initialization Failed',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return await handleRequest(request, env, ctx);
  },

  // 定时任务触发器
  async scheduled(event, env, ctx) {
    console.log('⏰ 收到定时任务触发');

    // 确保应用已初始化
    if (!rssManager) {
      try {
        initializeApp(env);
      } catch (error) {
        console.error('❌ 初始化失败:', error);
        return;
      }
    }

    // 执行监控任务
    ctx.waitUntil(performScheduledMonitoring(env));
  }
}; 