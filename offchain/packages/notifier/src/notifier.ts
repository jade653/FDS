import type {Alert, AlertSink, ConfigStore, Logger, RulesConfig} from "@stb/common";
import {silentLogger} from "@stb/common";

export interface Channel {
  readonly name: string;
  send(a: Alert, text: string): Promise<void>;
}

type Fetch = typeof fetch;

const ICON: Record<Alert["severity"], string> = {critical: "[CRITICAL]", warning: "[WARN]", info: "[INFO]"};

export function formatAlert(a: Alert): string {
  const out = [`${ICON[a.severity]} ${a.title}`];
  if (a.caseKey) out.push(`case ${a.caseKey}`);
  for (const l of a.lines) out.push(`- ${l}`);
  for (const l of a.approvalLinks ?? []) out.push(`  동결 승인 ${l.address}: ${l.url}`);
  return out.join("\n");
}

export class ConsoleChannel implements Channel {
  readonly name = "console";
  constructor(private readonly write: (s: string) => void = (s) => process.stdout.write(s + "\n")) {}
  async send(_a: Alert, text: string) {
    this.write(text);
  }
}

/** Slack incoming webhook (`{text}`) */
export class SlackChannel implements Channel {
  readonly name = "slack";
  constructor(private readonly url: string, private readonly f: Fetch = fetch) {}
  async send(_a: Alert, text: string) {
    const r = await this.f(this.url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({text})});
    if (!r.ok) throw new Error(`slack ${r.status}`);
  }
}

/** 일반 웹훅: 알림 객체를 JSON으로 그대로 보낸다. */
export class WebhookChannel implements Channel {
  readonly name = "webhook";
  constructor(private readonly url: string, private readonly f: Fetch = fetch) {}
  async send(a: Alert, text: string) {
    const r = await this.f(this.url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({...a, text})});
    if (!r.ok) throw new Error(`webhook ${r.status}`);
  }
}

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  constructor(private readonly token: string, private readonly chatId: string, private readonly f: Fetch = fetch) {}
  async send(_a: Alert, text: string) {
    const r = await this.f(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({chat_id: this.chatId, text, disable_web_page_preview: true}),
    });
    if (!r.ok) throw new Error(`telegram ${r.status}`);
  }
}

export function channelsFromConfig(cfg: RulesConfig["notifier"], env: NodeJS.ProcessEnv = process.env, f: Fetch = fetch): Channel[] {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`notifier channel needs env ${k}`);
    return v;
  };
  return cfg.channels.map((c) => {
    switch (c.type) {
      case "console":
        return new ConsoleChannel();
      case "slack":
        return new SlackChannel(need(c.webhook_url_env), f);
      case "webhook":
        return new WebhookChannel(need(c.url_env), f);
      case "telegram":
        return new TelegramChannel(need(c.bot_token_env), need(c.chat_id_env), f);
    }
  });
}

/**
 * 알림 발송 (design.md 7.1 Notifier). 설정이 바뀌면 다음 알림부터 새 채널을 쓴다.
 * 한 채널이 실패해도 나머지로 보내고, 모든 채널이 실패하면 로그에 남긴다.
 */
export class Notifier implements AlertSink {
  readonly history: Alert[] = [];
  private channels: Channel[];
  private readonly log: Logger;

  constructor(
    private readonly opts: {config?: ConfigStore; channels?: Channel[]; log?: Logger; historySize?: number},
  ) {
    this.log = opts.log ?? silentLogger;
    this.channels = opts.channels ?? (opts.config ? channelsFromConfig(opts.config.current().rules.notifier) : []);
    opts.config?.on("change", (c) => {
      if (opts.channels) return;
      try {
        this.channels = channelsFromConfig(c.rules.notifier);
      } catch (err) {
        this.log.error("notifier config invalid; keeping previous channels", {err: String(err)});
      }
    });
  }

  async alert(a: Alert): Promise<void> {
    this.history.push(a);
    if (this.history.length > (this.opts.historySize ?? 1000)) this.history.shift();
    const text = formatAlert(a);
    const results = await Promise.allSettled(this.channels.map((c) => c.send(a, text)));
    results.forEach((r, i) => {
      if (r.status === "rejected") this.log.error("channel failed", {channel: this.channels[i].name, err: String(r.reason)});
    });
  }
}
