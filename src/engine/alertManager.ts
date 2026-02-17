// ALERT MANAGER
// Sends notifications via Telegram and Discord webhooks with rate limiting

import { monitorLog } from './logger.js';
import { BotConfig } from './config.js';

type AlertLevel = 'info' | 'warn' | 'critical';

interface AlertRecord {
  lastSent: number;
}

const DISCORD_COLORS: Record<AlertLevel, number> = {
  info: 0x3498db,    // blue
  warn: 0xf39c12,    // orange
  critical: 0xe74c3c, // red
};

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  info: '\u2139\uFE0F',
  warn: '\u26A0\uFE0F',
  critical: '\uD83D\uDEA8',
};

const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes

export class AlertManager {
  private config: BotConfig;
  private rateLimitMap: Map<string, AlertRecord> = new Map();
  private telegramConfigured: boolean;
  private discordConfigured: boolean;

  constructor(config: BotConfig) {
    this.config = config;
    this.telegramConfigured = !!(config.telegramBotToken && config.telegramChatId);
    this.discordConfigured = !!config.discordWebhookUrl;

    if (!this.telegramConfigured) {
      monitorLog.warn('Telegram not configured - alerts will be logged only');
    }
    if (!this.discordConfigured) {
      monitorLog.warn('Discord not configured - alerts will be logged only');
    }

    monitorLog.info(
      { telegram: this.telegramConfigured, discord: this.discordConfigured },
      'AlertManager initialized'
    );
  }

  // ═══════════════════════════════════════════════
  // CORE ALERT DISPATCH
  // ═══════════════════════════════════════════════

  async sendAlert(
    level: AlertLevel,
    title: string,
    message: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    const dedupKey = `${level}:${title}`;
    if (this.isRateLimited(dedupKey)) {
      monitorLog.debug({ dedupKey }, 'Alert rate-limited, skipping');
      return;
    }

    this.markSent(dedupKey);

    const logData = { level, title, message, ...(data || {}) };
    if (level === 'critical') {
      monitorLog.error(logData, `ALERT: ${title}`);
    } else if (level === 'warn') {
      monitorLog.warn(logData, `ALERT: ${title}`);
    } else {
      monitorLog.info(logData, `ALERT: ${title}`);
    }

    const dataLines = data
      ? Object.entries(data)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n')
      : '';

    const fullText = [
      `${LEVEL_EMOJI[level]} [${level.toUpperCase()}] ${title}`,
      '',
      message,
      ...(dataLines ? ['', dataLines] : []),
    ].join('\n');

    const promises: Promise<void>[] = [];

    if (this.telegramConfigured) {
      promises.push(this.sendTelegram(fullText));
    }
    if (this.discordConfigured) {
      promises.push(this.sendDiscord(title, message + (dataLines ? `\n\n\`\`\`\n${dataLines}\n\`\`\`` : ''), DISCORD_COLORS[level]));
    }

    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }

  // ═══════════════════════════════════════════════
  // TRANSPORT: TELEGRAM
  // ═══════════════════════════════════════════════

  async sendTelegram(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.telegramChatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        monitorLog.error(
          { status: response.status, body },
          'Telegram API returned non-OK status'
        );
      }
    } catch (error) {
      monitorLog.error({ error }, 'Failed to send Telegram alert');
    }
  }

  // ═══════════════════════════════════════════════
  // TRANSPORT: DISCORD
  // ═══════════════════════════════════════════════

  async sendDiscord(title: string, message: string, color: number): Promise<void> {
    try {
      const response = await fetch(this.config.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [
            {
              title,
              description: message,
              color,
              timestamp: new Date().toISOString(),
              footer: { text: 'Solana MEV Bot' },
            },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        monitorLog.error(
          { status: response.status, body },
          'Discord webhook returned non-OK status'
        );
      }
    } catch (error) {
      monitorLog.error({ error }, 'Failed to send Discord alert');
    }
  }

  // ═══════════════════════════════════════════════
  // TYPED ALERT METHODS
  // ═══════════════════════════════════════════════

  async alertCircuitBreaker(failures: number): Promise<void> {
    await this.sendAlert(
      'critical',
      'Circuit Breaker Triggered',
      `Trading halted after ${failures} consecutive failures. Manual review required.`,
      { consecutive_failures: failures }
    );
  }

  async alertDailyLossLimit(lossSol: number, limitSol: number): Promise<void> {
    await this.sendAlert(
      'critical',
      'Daily Loss Limit Reached',
      `Daily loss of ${lossSol.toFixed(4)} SOL has exceeded the limit of ${limitSol.toFixed(4)} SOL. Trading suspended for today.`,
      { loss_sol: lossSol.toFixed(4), limit_sol: limitSol.toFixed(4) }
    );
  }

  async alertTradeExecuted(
    strategy: string,
    profitSol: number,
    profitUsd: number
  ): Promise<void> {
    if (profitUsd <= 1) {
      return;
    }

    await this.sendAlert(
      'info',
      'Trade Executed',
      `Strategy "${strategy}" completed with +${profitSol.toFixed(6)} SOL ($${profitUsd.toFixed(2)}).`,
      { strategy, profit_sol: profitSol.toFixed(6), profit_usd: profitUsd.toFixed(2) }
    );
  }

  async alertStuckToken(
    symbol: string,
    mint: string,
    balance: string
  ): Promise<void> {
    await this.sendAlert(
      'warn',
      'Stuck Token Detected',
      `Token ${symbol} (${mint.slice(0, 8)}...) with balance ${balance} could not be swapped back to SOL.`,
      { symbol, mint, balance }
    );
  }

  async alertBalanceLow(balanceSol: number, thresholdSol: number): Promise<void> {
    await this.sendAlert(
      'critical',
      'Low Balance Warning',
      `Wallet balance is ${balanceSol.toFixed(4)} SOL, below the threshold of ${thresholdSol.toFixed(4)} SOL. Deposit funds or reduce position sizes.`,
      { balance_sol: balanceSol.toFixed(4), threshold_sol: thresholdSol.toFixed(4) }
    );
  }

  async alertBotStarted(): Promise<void> {
    await this.sendAlert(
      'info',
      'Bot Started',
      `MEV bot is online and scanning for opportunities. Risk level: ${this.config.riskLevel}.`,
      { risk_level: this.config.riskLevel }
    );
  }

  async alertBotStopped(): Promise<void> {
    await this.sendAlert(
      'info',
      'Bot Stopped',
      'MEV bot has been shut down gracefully.'
    );
  }

  async alertRpcFailover(from: string, to: string): Promise<void> {
    await this.sendAlert(
      'warn',
      'RPC Failover',
      `Switched RPC endpoint from ${from} to ${to} due to connectivity issues.`,
      { from_endpoint: from, to_endpoint: to }
    );
  }

  // ═══════════════════════════════════════════════
  // RATE LIMITING
  // ═══════════════════════════════════════════════

  private isRateLimited(key: string): boolean {
    const record = this.rateLimitMap.get(key);
    if (!record) return false;
    return Date.now() - record.lastSent < RATE_LIMIT_MS;
  }

  private markSent(key: string): void {
    this.rateLimitMap.set(key, { lastSent: Date.now() });

    // Periodically clean up stale entries to prevent memory leaks
    if (this.rateLimitMap.size > 1000) {
      const now = Date.now();
      const keysToDelete: string[] = [];
      this.rateLimitMap.forEach((v, k) => {
        if (now - v.lastSent > RATE_LIMIT_MS) {
          keysToDelete.push(k);
        }
      });
      keysToDelete.forEach(k => this.rateLimitMap.delete(k));
    }
  }
}
