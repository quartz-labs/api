import { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { AccountLayout } from '@solana/spl-token';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { getComputeUnitLimit, getComputeUnitPrice, getMarketIndicesRecord, getTokenProgram, MarketIndex, TOKENS } from '@quartz-labs/sdk';
import { QuartzClient } from '@quartz-labs/sdk';
import { MICRO_LAMPORTS_PER_LAMPORT } from '../../../config/constants.js';
import { makeDepositIxs } from '../build-tx/deposit.js';


export const getDepositLimits = async (address: PublicKey, connection: Connection): Promise<Record<MarketIndex, number>> => {

    const limits = getMarketIndicesRecord<number>(0);
    for (const marketIndex of MarketIndex) {
        limits[marketIndex] = await fetchDepositLimit(connection, address, marketIndex);
    }

    return limits;
}

async function fetchDepositLimit(connection: Connection, pubkey: PublicKey, marketIndex: MarketIndex): Promise<number> {
    const [marketIndexSolString] = Object.entries(TOKENS).find(([, token]) => token.name === "SOL") ?? [];
    const marketIndexSol = Number(marketIndexSolString);
    if (isNaN(marketIndexSol)) {
        throw new Error("SOL market index not found");
    }

    if (marketIndex === marketIndexSol) {
        return await fetchMaxDepositLamports(pubkey, connection, marketIndexSol);
    }

    return await fetchMaxDepositSpl(pubkey, connection, TOKENS[marketIndex].mint);
}

async function fetchMaxDepositLamports(pubkey: PublicKey, connection: Connection, marketIndexSol: MarketIndex) {
    const quartzClient = await QuartzClient.fetchClient(connection);
    const user = await quartzClient.getQuartzAccount(pubkey);
    const balanceLamportsPromise = connection.getBalance(pubkey);
    const wSolAtaRentPromise = connection.getMinimumBalanceForRentExemption(AccountLayout.span);
    const depositPromise = makeDepositIxs(connection, pubkey, 1, marketIndexSol, user, false);

    const [
        deposit,
        blockhash
    ] = await Promise.all([
        depositPromise,
        connection.getLatestBlockhash().then(res => res.blockhash)
    ]);
    const { ixs: depositIxs } = deposit;

    const [
        computeUnitLimit,
        computeUnitPrice,
        balanceLamports,
        wSolAtaRent
    ] = await Promise.all([
        getComputeUnitLimit(connection, depositIxs, pubkey, blockhash, []),
        getComputeUnitPrice(connection, depositIxs),
        balanceLamportsPromise,
        wSolAtaRentPromise
    ]);

    const baseSignerFeeLamports = 5000;
    const priorityFeeLamports = (computeUnitPrice * computeUnitLimit) / MICRO_LAMPORTS_PER_LAMPORT;
    const maxDeposit = balanceLamports - (wSolAtaRent * 2) - (baseSignerFeeLamports + priorityFeeLamports);

    return Math.max(maxDeposit, 0);
}

async function fetchMaxDepositSpl(pubkey: PublicKey, connection: Connection, mint: PublicKey) {
    const tokenProgram = await getTokenProgram(connection, mint);
    const tokenAccount = await getAssociatedTokenAddress(mint, pubkey, false, tokenProgram);
    try {
        const balance = await connection.getTokenAccountBalance(tokenAccount);
        return Number(balance.value.amount);
    } catch {
        return 0;
    }
}
