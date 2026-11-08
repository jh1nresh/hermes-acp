/**
 * execute-trust-swap.ts
 *
 * Full E2E: create trust_swap job → wait for calldata → broadcast on Base.
 *
 * Usage:
 *   EXECUTOR_PRIVATE_KEY=0x... npx ts-node src/scripts/execute-trust-swap.ts
 *
 * Env vars required:
 *   EXECUTOR_PRIVATE_KEY  — wallet that holds WETH and will broadcast
 *   ALCHEMY_BASE_RPC      — Base RPC (optional, defaults to public)
 *
 * The swapper address is derived from EXECUTOR_PRIVATE_KEY automatically.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createWalletClient, createPublicClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { execSync } from "child_process";

// ── Config ────────────────────────────────────────────────────────────────────

const MAIAT_WALLET = "0xAf1aE6F344c60c7Fe56CB53d1809f2c0B997a2b9";
const WETH_BASE = "0x4200000000000000000000000000000000000006";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RPC_URL = process.env.ALCHEMY_BASE_RPC ?? "https://mainnet.base.org";
const PRIVATE_KEY = process.env.EXECUTOR_PRIVATE_KEY as `0x${string}`;

if (!PRIVATE_KEY) {
  console.error("❌  Set EXECUTOR_PRIVATE_KEY=0x...");
  process.exit(1);
}

// ── Wallet setup ──────────────────────────────────────────────────────────────

const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({ account, chain: base, transport: http(RPC_URL) });
const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });

// ── Swap params ────────────────────────────────────────────────────────────────

const SWAP = {
  tokenIn: WETH_BASE,
  tokenOut: USDC_BASE, // ← change to any token you want
  amountIn: "0.001", // ← ETH amount (small for testing)
  slippage: 0.5,
  swapper: account.address,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function acp(cmd: string): string {
  return execSync(`acp ${cmd}`, { encoding: "utf8" });
}

function pollJobStatus(jobId: string, maxWaitMs = 60_000): Record<string, unknown> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const raw = acp(`job status ${jobId} --json 2>/dev/null || acp job status ${jobId}`);
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.phase === "COMPLETED" || parsed.phase === "EVALUATION") {
        return parsed;
      }
      if (parsed.phase === "REJECTED") throw new Error("Job rejected by Maiat");
    } catch {
      // JSON parse failed — ACP CLI returned text, keep polling
    }
    console.log("  ⏳ waiting for Maiat to process...");
    execSync("sleep 5");
  }
  throw new Error("Timeout waiting for trust_swap deliverable");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🛡️  Maiat trust_swap executor`);
  console.log(`   Swapper : ${account.address}`);
  console.log(`   Swap    : ${SWAP.amountIn} WETH → USDC`);
  console.log(`   RPC     : ${RPC_URL}\n`);

  // Step 1: Create trust_swap job
  console.log("1️⃣  Creating trust_swap job...");
  const createOut = acp(
    `job create ${MAIAT_WALLET} trust_swap ` + `--requirements '${JSON.stringify(SWAP)}'`
  );
  const jobIdMatch = createOut.match(/Job ID\s+(\d+)/);
  if (!jobIdMatch) throw new Error(`Could not parse job ID from: ${createOut}`);
  const jobId = jobIdMatch[1];
  console.log(`   Job ID: ${jobId} ✅`);

  // Step 2: Poll for deliverable
  console.log("2️⃣  Waiting for trust_swap deliverable...");
  const job = pollJobStatus(jobId);

  // Step 3: Parse calldata from deliverable
  const deliverableRaw = (job.deliverable as string) ?? "";
  let deliverable: Record<string, unknown>;
  try {
    deliverable = JSON.parse(deliverableRaw);
  } catch {
    throw new Error(`Could not parse deliverable: ${deliverableRaw}`);
  }

  const { calldata, to, value, trustScore, verdict, riskSummary } = deliverable as {
    calldata: string;
    to: string;
    value: string;
    trustScore: number;
    verdict: string;
    riskSummary: string;
  };

  console.log(`\n   Trust check: ${trustScore}/100 (${verdict})`);
  console.log(`   Summary    : ${riskSummary}`);

  if (verdict === "avoid") {
    console.log("🚫  Trust check failed — aborting broadcast. Funds safe.");
    process.exit(1);
  }

  if (!calldata || calldata === "" || !to) {
    console.log("⚠️   No calldata returned (quote-only mode or Vercel not yet deployed).");
    console.log("   Calldata will appear once Vercel deploys the getSwap fix.");
    process.exit(0);
  }

  // Step 4: Broadcast
  console.log(`\n3️⃣  Broadcasting swap on Base...`);
  console.log(`   To    : ${to}`);
  console.log(`   Value : ${value ?? "0"} wei`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txHash = (await (walletClient as any).sendTransaction({
    to: to as `0x${string}`,
    data: calldata as `0x${string}`,
    value: BigInt(value ?? "0"),
  })) as `0x${string}`;

  console.log(`\n✅  TX sent: ${txHash}`);
  console.log(`   BaseScan: https://basescan.org/tx/${txHash}`);

  // Step 5: Wait for receipt
  console.log("   Waiting for confirmation...");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`\n🎉  Confirmed in block ${receipt.blockNumber} (status: ${receipt.status})`);
}

main().catch((err) => {
  console.error("\n❌ ", err.message ?? err);
  process.exit(1);
});
