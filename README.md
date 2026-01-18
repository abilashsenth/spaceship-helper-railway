# Polymarket WebSocket Listener

Real-time WebSocket listener for Polymarket CLOB data. Pushes orderbook, price, and trade updates to Upstash Redis.

## Deploy to Railway

1. Fork/clone this repo
2. Connect to Railway
3. Add environment variables:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
4. Deploy!

## Environment Variables

| Variable | Description |
|----------|-------------|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis auth token |

## How it Works

1. Connects to Polymarket WebSocket
2. Reads subscriptions from Redis set `ws-subscriptions`
3. Pushes updates to Redis:
   - `orderbook:{tokenId}` - Top 10 bids/asks
   - `price:{tokenId}` - Current prices
   - `trades:{tokenId}` - Recent trades

## Local Development

```bash
npm install
# Create .env with your credentials
npm start
```
