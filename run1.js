const axios = require('axios');
const ethers = require('ethers');
const dotenv = require('dotenv');
const readline = require('readline');
const fs = require('fs');

dotenv.config();

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

async function buildFallbackProvider(rpcUrls, chainId, name) {
  const provider = new ethers.JsonRpcProvider(rpcUrls[0], { chainId, name });
  return {
    getProvider: async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await provider.getBlockNumber();
          return provider;
        } catch (e) {
          throw e;
        }
      }
      throw new Error('All RPC retries failed');
    }
  };
}

const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[37m",
  bold: "\x1b[1m",
  blue: "\x1b[34m"
};

const logger = {
  info: (msg) => console.log(`${colors.green}[✓] ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}[⚠] ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}[✗] ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}[✅] ${msg}${colors.reset}`),
  step: (msg) => console.log(`${colors.white}[➤] ${msg}${colors.reset}`),
  countdown: (msg) => process.stdout.write(`\r${colors.blue}[⏰] ${msg}${colors.reset}`),
  banner: () => {
    console.log(`${colors.cyan}${colors.bold}`);
    console.log(`---------------------------------------------`);
    console.log(`            Faroswap Auto Bot  `);
    console.log(`---------------------------------------------${colors.reset}`);
    console.log();
  }
};

const TOKENS = {
  PHRS: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  USDT: '0xD4071393f8716661958F766DF660033b3d35fD29'
};

const PHAROS_CHAIN_ID = 688688;
const PHAROS_RPC_URLS = ['https://testnet.dplabs-internal.com'];
const DODO_ROUTER = '0x73CAfc894dBfC181398264934f7Be4e482fc9d40';
const PHRS_TO_USDT_AMOUNT = ethers.parseEther('0.00245');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64)...', // truncated for brevity
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)...'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function loadPrivateKeys() {
  const keys = [];
  let i = 1;
  while (process.env[`PRIVATE_KEY_${i}`]) {
    const pk = process.env[`PRIVATE_KEY_${i}`];
    if (pk.startsWith('0x') && pk.length === 66) keys.push(pk);
    else logger.warn(`Invalid PRIVATE_KEY_${i} in .env, skipping...`);
    i++;
  }
  return keys;
}

async function fetchWithTimeout(url, timeout = 15000) {
  try {
    const source = axios.CancelToken.source();
    const timeoutId = setTimeout(() => source.cancel('Timeout'), timeout);
    const res = await axios.get(url, {
      cancelToken: source.token,
      headers: { 'User-Agent': getRandomUserAgent() }
    });
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    throw new Error('Timeout or network error');
  }
}

async function robustFetchDodoRoute(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetchWithTimeout(url);
      const data = res.data;
      if (data.status !== -1) return data;
      logger.warn(`Retry ${i + 1} DODO API status -1`);
    } catch (e) {
      logger.warn(`Retry ${i + 1} failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('DODO API permanently failed');
}

async function fetchDodoRoute(fromAddr, toAddr, userAddr, amountWei) {
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const url = `https://api.dodoex.io/route-service/v2/widget/getdodoroute?chainId=${PHAROS_CHAIN_ID}&deadLine=${deadline}&toTokenAddress=${toAddr}&fromTokenAddress=${fromAddr}&userAddr=${userAddr}&fromAmount=${amountWei}`;
  const result = await robustFetchDodoRoute(url);
  if (!result.data || !result.data.data) throw new Error('Invalid DODO API response');
  logger.success('DODO Route Info fetched successfully');
  return result.data;
}

async function approveToken(wallet, tokenAddr, amount) {
  if (tokenAddr === TOKENS.PHRS) return true;
  const contract = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
  const balance = await contract.balanceOf(wallet.address);
  if (balance < amount) {
    logger.error(`Insufficient USDT balance: ${ethers.formatUnits(balance, 6)} USDT`);
    return false;
  }
  const allowance = await contract.allowance(wallet.address, DODO_ROUTER);
  if (allowance >= amount) return true;
  const tx = await contract.approve(DODO_ROUTER, amount);
  await tx.wait();
  return true;
}

async function executeSwap(wallet, routeData, fromAddr, amount) {
  if (fromAddr !== TOKENS.PHRS) {
    const approved = await approveToken(wallet, fromAddr, amount);
    if (!approved) throw new Error('Token approval failed');
  }
  const nonce = await wallet.getNonce('pending');
  const tx = await wallet.sendTransaction({
    to: routeData.to,
    data: routeData.data,
    value: BigInt(routeData.value),
    gasLimit: BigInt(routeData.gasLimit || 500000),
    nonce: nonce
  });
  await tx.wait();
  logger.success(`Swap Transaction confirmed! TX Hash: ${tx.hash}`);
  return tx;
}

async function batchSwap(wallet, count = 1) {  
  const swaps = [];
  for (let i = 0; i < count; i++) {
    swaps.push({ 
      from: TOKENS.PHRS, 
      to: TOKENS.USDT, 
      amount: PHRS_TO_USDT_AMOUNT, 
      decimals: 18 
    });
  }

  for (let i = 0; i < swaps.length; i++) {
    const { from, to, amount } = swaps[i];
    const pair = 'PHRS -> USDT';
    logger.step(`Swap #${i + 1} of ${count}: ${pair} for wallet ${wallet.address}`);
    try {
      const data = await fetchDodoRoute(from, to, wallet.address, amount);
      await executeSwap(wallet, data, from, amount);
    } catch (e) {
      logger.error(`Swap #${i + 1} failed for wallet ${wallet.address}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function showCountdown() {
  const now = new Date();
  const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  return new Promise(resolve => {
    const interval = setInterval(() => {
      const remaining = twoHoursLater - new Date();
      const hours = Math.floor(remaining / (1000 * 60 * 60));
      const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((remaining % (1000 * 60)) / 1000);
      logger.countdown(`Next swap cycle in ${hours}h ${minutes}m ${seconds}s`);
      if (remaining <= 0) {
        clearInterval(interval);
        process.stdout.write('\n');
        resolve();
      }
    }, 1000);
  });
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

(async () => {
  logger.banner();
  const fallbackProvider = await buildFallbackProvider(PHAROS_RPC_URLS, PHAROS_CHAIN_ID, 'pharos');
  const provider = await fallbackProvider.getProvider();
  const privateKeys = loadPrivateKeys();

  if (privateKeys.length === 0) {
    logger.error('No valid private keys found in .env');
    process.exit(1);
  }

  const count = await question(`${colors.cyan}How many swaps to perform per wallet? ${colors.reset}`);
  const countNum = parseInt(count) || 1;

  while (true) {
    for (const [index, privateKey] of privateKeys.entries()) {
      try {
        const wallet = new ethers.Wallet(privateKey, provider);
        logger.success(`Processing wallet ${index + 1}/${privateKeys.length}: ${wallet.address}`);
        await batchSwap(wallet, countNum);
        logger.success(`Swap cycle completed for wallet ${wallet.address}!`);
      } catch (err) {
        logger.error(`Wallet ${index + 1} failed: ${err.message}`);
      }
    }
    logger.step('All wallets processed for this cycle. Waiting for next cycle...');
    await showCountdown();
  }

  rl.close();
})();
