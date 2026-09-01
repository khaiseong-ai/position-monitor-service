# 套利仓位监控

本工具每 5 分钟通过 REST 拉取所有配置交易所仓位，并用 Binance user data stream 做近实时补充检查。发现单腿或 long/short size 不平衡时，会发送 Telegram。

## 使用

1. 复制 `.env.example` 为 `.env`。
2. 填入只读 API key、Telegram bot token、Telegram chat id。
3. Bitget 必须填 `BITGET_API_PASSPHRASE`。
4. Hyperliquid 填你的钱包地址到 `HYPERLIQUID_WALLET`。
5. 启动：

```bash
npm start
```

打开：

```text
http://localhost:8787
```

## Vercel 试跑

Vercel 版本只使用 REST，不使用 WebSocket。Hobby 账号不能使用每 5 分钟 Vercel Cron；可以用外部 cron 服务每 5 分钟访问 `/api/check?notify=1&secret=你的CRON_SECRET`。网页访问 `/api/state` 实时检查一次当前仓位。

把 `.env.example` 里的变量填到 Vercel Project Settings -> Environment Variables，然后部署本目录。

注意：如果没有 KV/数据库，Vercel 不能可靠保存上一次告警状态；异常存在时 Cron 可能每 5 分钟发一次 Telegram。

## GitHub Actions 常驻检查

`.github/workflows/position-monitor.yml` 可在电脑关机时每 5 分钟执行一次 REST 检查，并把最新成功快照覆盖到 Google Sheet 的 `Position_Monitor` 分页。每 30 分钟的检查也会发送当前 Telegram 告警。

仓库 Secrets 必须包含 `.env.example` 中的交易所、Telegram 和 `POSITION_SHEET_*` 凭证。任务遇到任一交易所错误时会失败关闭：不覆盖 Sheet，只在通知轮次发送不含 API 回应或仓位资料的健康告警。

GitHub Actions 会优先使用 Backpack 只读 API 密钥直连；只有没有 Backpack 密钥时，本地和 Vercel 模式才会退回 `BACKPACK_PROXY_URL`。

## 告警规则

按标准化后的 `symbol` 汇总：

- 只有 long 或只有 short：告警
- long 和 short 都存在但 size 差额大于 `TOLERANCE`：告警
- `TOLERANCE=0` 表示必须完全相等

## 安全

不要把 `.env` 提交到任何仓库。交易所 key 只给读取权限，禁用交易和提现，最好绑定服务器 IP。
