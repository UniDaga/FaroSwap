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
          if (e.code === 'UNKNOWN_ERROR' && e.error && e.error.code === -32603) {
            console.log(`${colors.yellow}[⚠] RPC busy, retrying ${i + 1}/3...${colors.reset}`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
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
  blue: "\x1b[34m",
  magenta: "\x1b[35m"
};

const logger = {
  info: (msg) => console.log(`${colors.green}[✓] ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}[⚠] ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}[✗] ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}[✅] ${msg}${colors.reset}`),
  loading: (msg) => console.log(`${colors.cyan}[⟳] ${msg}${colors.reset}`),
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
const USDT_TO_PHRS_AMOUNT = ethers.parseUnits('1', 6);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.101 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:89.0) Gecko/20100101 Firefox/89.0'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function loadPrivateKeys() {
  const keys = [];
  let i = 1;
  while (process.env[`PRIVATE_KEY_${i}`]) {
    const pk = process.env[`PRIVATE_KEY_${i}`];
    if (pk.startsWith('0x') && pk.length === 66) {
      keys.push(pk);
    } else {
      logger.warn(`Invalid PRIVATE_KEY_${i} in .env, skipping...`);
    }
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
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.8',
        'priority': 'u=1, i',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Brave";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'sec-gpc': '1',
        'Referer': 'https://faroswap.xyz/',
        'User-Agent': getRandomUserAgent()
      }
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
  const url = `https://api.dodoex.io/route-service/v2/widget/getdodoroute?chainId=${PHAROS_CHAIN_ID}&deadLine=${deadline}&apikey=a37546505892e1a952&slippage=3.225&source=dodoV2AndMixWasm&toTokenAddress=${toAddr}&fromTokenAddress=${fromAddr}&userAddr=${userAddr}&estimateGas=true&fromAmount=${amountWei}`;
  try {
    const result = await robustFetchDodoRoute(url);
    if (!result.data || !result.data.data) {
      throw new Error('Invalid DODO API response: missing data field');
    }
    logger.success('DODO Route Info fetched successfully');
    return result.data;
  } catch (err) {
    logger.error(`DODO API fetch failed: ${err.message}`);
    throw err;
  }
}

async function approveToken(wallet, tokenAddr, amount) {
  if (tokenAddr === TOKENS.PHRS) return true;
  const contract = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
  try {
    const balance = await contract.balanceOf(wallet.address);
    if (balance < amount) {
      logger.error(`Insufficient USDT balance: ${ethers.formatUnits(balance, 6)} USDT`);
      return false;
    }
    const allowance = await contract.allowance(wallet.address, DODO_ROUTER);
    if (allowance >= amount) {
      logger.info('Token already approved');
      return true;
    }
    logger.step(`Approving ${ethers.formatUnits(amount, 6)} USDT for DODO router`);
    const tx = await contract.approve(DODO_ROUTER, amount);
    logger.success(`Approval TX sent: ${tx.hash}`);
    await tx.wait();
    logger.success('Approval confirmed');
    return true;
  } catch (e) {
    logger.error(`Approval failed: ${e.message}`);
    return false;
  }
}

async function executeSwap(wallet, routeData, fromAddr, amount, retryCount = 0) {
  if (fromAddr !== TOKENS.PHRS) {
    const approved = await approveToken(wallet, fromAddr, amount);
    if (!approved) throw new Error('Token approval failed');
  }
  try {
    if (!routeData.data || routeData.data === '0x') {
      throw new Error('Invalid transaction data from DODO API');
    }
    const nonce = await wallet.getNonce('pending');
    const tx = await wallet.sendTransaction({
      to: routeData.to,
      data: routeData.data,
      value: BigInt(routeData.value),
      gasLimit: BigInt(routeData.gasLimit || 500000),
      nonce: nonce
    });
    logger.success(`Swap Transaction sent! TX Hash: ${tx.hash}`);
    const receipt = await tx.wait();
    logger.success('Transaction confirmed!');
    return receipt;
  } catch (e) {
    if (e.code === 'TRANSACTION_REPLACED' && e.replacement && e.replacement.receipt && e.replacement.receipt.status === 1) {
      logger.success(`Transaction was replaced but succeeded! Replacement TX Hash: ${e.replacement.hash}`);
      return e.replacement.receipt;
    }
    if (retryCount < 3) {
      logger.warn(`Retrying swap (${retryCount + 1}/3) due to error: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
      return executeSwap(wallet, routeData, fromAddr, amount, retryCount + 1);
    }
    logger.error(`Swap TX failed: ${e.message}`);
    throw e;
  }
}

async function batchSwap(wallet, count) {
  const swaps = [];
  for (let i = 0; i < count; i++) {
    swaps.push(i % 2 === 0 ? 
      { from: TOKENS.PHRS, to: TOKENS.USDT, amount: PHRS_TO_USDT_AMOUNT, decimals: 18 } :
      { from: TOKENS.USDT, to: TOKENS.PHRS, amount: USDT_TO_PHRS_AMOUNT, decimals: 6 }
    );
  }

  for (let i = 0; i < swaps.length; i++) {
    const { from, to, amount, decimals } = swaps[i];
    const pair = from === TOKENS.PHRS ? 'PHRS -> USDT' : 'USDT -> PHRS';
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

  
  const count = await question(`${colors.cyan}How many swaps to perform per wallet (PHRS-USDT/USDT-PHRS)? ${colors.reset}`);
  const countNum = parseInt(count);
  if (isNaN(countNum) || countNum < 1) {
    logger.error('Invalid swap count');
    rl.close();
    process.exit(1);
  }

  while (true) {
    
    for (const [index, privateKey] of privateKeys.entries()) {
      try {
        const wallet = new ethers.Wallet(privateKey, provider);
        logger.success(`Processing wallet ${index + 1}/${privateKeys.length}: ${wallet.address}`);
        await batchSwap(wallet, countNum);
        logger.success(`Swap cycle completed for wallet ${wallet.address}!`);
      } catch (err) {
        logger.error(`Wallet ${index + 1} failed: ${err.message}`);
        continue; 
      }
    }

    logger.step('All wallets processed for this cycle. Waiting for next daily cycle...');
    await showCountdown();
  }

  rl.close();
})();
