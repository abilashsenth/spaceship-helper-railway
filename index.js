#!/usr/bin/env node
/**
 * WebSocket Listener for Polymarket CLOB
 * Connects to Polymarket WebSocket, pushes real-time data to Upstash Redis
 * 
 * Deploy to Railway for 24/7 operation
 */

require('dotenv').config();
const WebSocket = require('ws');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

if (!REDIS_URL || !REDIS_TOKEN) {
  console.error('❌ Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  process.exit(1);
}

let ws = null;
let subscriptions = new Set();
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000;

// Redis helper
async function redisHSet(key, data) {
  const args = ["HSET", key, ...Object.entries(data).flat()];
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  return res.json();
}

async function redisLPush(key, value) {
  const res = await fetch(`${REDIS_URL}/lpush/${key}/${encodeURIComponent(value)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  return res.json();
}

async function redisLTrim(key, start, stop) {
  const res = await fetch(`${REDIS_URL}/ltrim/${key}/${start}/${stop}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  return res.json();
}

async function redisExpire(key, seconds) {
  const res = await fetch(`${REDIS_URL}/expire/${key}/${seconds}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  return res.json();
}

async function redisSMembers(key) {
  const res = await fetch(`${REDIS_URL}/smembers/${key}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const data = await res.json();
  return data.result || [];
}

// Load subscriptions from Redis
async function loadSubscriptions() {
  try {
    const subs = await redisSMembers('ws-subscriptions');
    subscriptions = new Set(subs);
    console.log(`📋 Loaded ${subscriptions.size} subscriptions from Redis`);
  } catch (err) {
    console.error('Failed to load subscriptions:', err.message);
  }
}

// Save orderbook to Redis
async function saveOrderbook(tokenId, orderbook) {
  const bids = orderbook.bids?.slice(0, 10) || [];
  const asks = orderbook.asks?.slice(0, 10) || [];
  const bestBid = parseFloat(bids[0]?.price) || 0;
  const bestAsk = parseFloat(asks[0]?.price) || 0;
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;

  await redisHSet(`orderbook:${tokenId}`, {
    bids: JSON.stringify(bids),
    asks: JSON.stringify(asks),
    mid: mid.toFixed(4),
    spread: spread.toFixed(4),
    lastUpdate: new Date().toISOString()
  });
  await redisExpire(`orderbook:${tokenId}`, 60);
  
  // Also update price
  await redisHSet(`price:${tokenId}`, {
    bid: bestBid.toString(),
    ask: bestAsk.toString(),
    mid: mid.toFixed(4),
    last: mid.toFixed(4),
    lastUpdate: new Date().toISOString()
  });
  await redisExpire(`price:${tokenId}`, 60);
}

// Save trade to Redis
async function saveTrade(tokenId, trade) {
  const tradeData = JSON.stringify({
    side: trade.side,
    price: parseFloat(trade.price),
    size: parseFloat(trade.size),
    timestamp: Date.now()
  });
  await redisLPush(`trades:${tokenId}`, tradeData);
  await redisLTrim(`trades:${tokenId}`, 0, 99);
}

// Connect to WebSocket
function connect() {
  console.log('🔌 Connecting to Polymarket WebSocket...');
  
  ws = new WebSocket(WS_URL);
  
  ws.on('open', () => {
    console.log('✅ Connected to Polymarket WebSocket');
    reconnectAttempts = 0;
    
    subscriptions.forEach(tokenId => {
      subscribe(tokenId);
    });
  });
  
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.event_type === 'book') {
        const tokenId = msg.asset_id;
        if (tokenId && subscriptions.has(tokenId)) {
          await saveOrderbook(tokenId, msg);
          console.log(`📊 Orderbook: ${tokenId.slice(0, 16)}...`);
        }
      } else if (msg.event_type === 'last_trade_price') {
        const tokenId = msg.asset_id;
        if (tokenId && subscriptions.has(tokenId)) {
          await saveTrade(tokenId, msg);
          console.log(`💱 Trade: ${tokenId.slice(0, 16)}...`);
        }
      } else if (msg.event_type === 'price_change') {
        const tokenId = msg.asset_id;
        if (tokenId) {
          await redisHSet(`price:${tokenId}`, {
            bid: msg.price || '0',
            ask: msg.price || '0',
            mid: msg.price || '0',
            last: msg.price || '0',
            lastUpdate: new Date().toISOString()
          });
        }
      }
    } catch (err) {
      // Ignore parse errors
    }
  });
  
  ws.on('close', () => {
    console.log('❌ WebSocket disconnected');
    attemptReconnect();
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
  
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);
}

function attemptReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('Max reconnection attempts reached. Exiting.');
    process.exit(1);
  }
  
  reconnectAttempts++;
  console.log(`🔄 Reconnecting in ${RECONNECT_DELAY/1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  setTimeout(connect, RECONNECT_DELAY);
}

function subscribe(tokenId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'market',
      assets_ids: [tokenId]
    }));
    console.log(`📡 Subscribed to ${tokenId.slice(0, 16)}...`);
  }
}

// Check for new subscriptions periodically
async function checkSubscriptions() {
  try {
    const newSubs = await redisSMembers('ws-subscriptions');
    const newSet = new Set(newSubs);
    
    for (const tokenId of newSet) {
      if (!subscriptions.has(tokenId)) {
        subscriptions.add(tokenId);
        subscribe(tokenId);
      }
    }
    
    for (const tokenId of subscriptions) {
      if (!newSet.has(tokenId)) {
        subscriptions.delete(tokenId);
      }
    }
  } catch (err) {
    console.error('Failed to check subscriptions:', err.message);
  }
}

// Main
async function main() {
  console.log('🚀 Polymarket WebSocket Listener');
  console.log('================================\n');
  
  await loadSubscriptions();
  connect();
  
  setInterval(checkSubscriptions, 10000);
  
  console.log('\n💡 Tokens managed via Redis set "ws-subscriptions"');
}

main().catch(console.error);
